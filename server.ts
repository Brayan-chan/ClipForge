import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import type { ClipRecord, ScoringConfig, TranscriptSegment } from './src/types';
import {
  CLIPS_DIR,
  DEFAULT_SUBTITLE_STYLE,
  THUMBNAILS_DIR,
  TRANSCRIPTS_DIR,
  UPLOADS_DIR,
  ensureStorageDirs,
  getStorageUsageBytes,
  mutateDb,
  readDb,
  recoverInterruptedJobs,
} from './server/db';
import { runVideoPipeline } from './server/pipeline';
import { processingQueue } from './server/queue';
import {
  detectCandidateClipsHeuristic,
  parseSrtFileContent,
  parseSrtOrTextTranscript,
  scoreWindow,
} from './server/processing/clipScorer';
import {
  isGeminiConfigured,
  refineCandidatesWithGemini,
} from './server/processing/geminiClient';
import { renderClipWithFfmpeg } from './server/processing/renderer';
import {
  SAMPLE_PODCAST_SEGMENTS,
  generateDemoPodcastVideo,
} from './server/processing/sampleGenerator';
import {
  MAX_VIDEO_SIZE_BYTES,
  generateSafeMediaFilename,
  safeUnlink,
  validateUploadedFileMeta,
} from './server/processing/validation';
import {
  analyzeVideo,
  checkFfmpegBinaries,
  generateThumbnail,
} from './server/processing/videoAnalyzer';

ensureStorageDirs();
const recoveredCount = recoverInterruptedJobs();
if (recoveredCount > 0) {
  console.log(`[ClipForge] Recovered ${recoveredCount} interrupted job(s) from previous session.`);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Expose ONLY safe public media subdirectories (never expose clipforge.db.json or transcripts/)
app.use('/storage/uploads', express.static(UPLOADS_DIR));
app.use('/storage/thumbnails', express.static(THUMBNAILS_DIR));
app.use('/storage/clips', express.static(CLIPS_DIR));
app.use('/storage', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureStorageDirs();
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    cb(null, generateSafeMediaFilename(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_VIDEO_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    const check = validateUploadedFileMeta({
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: 1,
    });
    if (!check.valid) {
      cb(new Error(check.error));
      return;
    }
    cb(null, true);
  },
});

const srtUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.srt') {
      cb(new Error('Only .srt subtitle files are allowed.'));
      return;
    }
    cb(null, true);
  },
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'clipforge' });
});

app.get('/api/status', async (_req, res) => {
  const binaries = await checkFfmpegBinaries();
  const db = readDb();
  const queueStats = processingQueue.getStats();
  res.json({
    ffmpegAvailable: binaries.ffmpegAvailable,
    ffprobeAvailable: binaries.ffprobeAvailable,
    geminiConfigured: isGeminiConfigured(),
    storageBytes: getStorageUsageBytes(),
    activeQueueTasks: queueStats.active,
    queuedTasks: queueStats.queued,
    tableCounts: {
      users: db.users.length,
      projects: db.projects.length,
      videos: db.videos.length,
      transcriptions: db.transcriptions.length,
      clips: db.clips.length,
      processingJobs: db.processingJobs.length,
    },
  });
});

app.get('/api/workspace', (_req, res) => {
  const db = readDb();
  res.json({
    projects: db.projects,
    videos: [...db.videos].sort((a, b) => b.id - a.id),
    transcriptions: db.transcriptions,
    clips: [...db.clips].sort((a, b) => b.score - a.score),
    jobs: db.processingJobs,
    scoringConfig: db.scoringConfig,
  });
});

app.post('/api/projects', async (req, res) => {
  const { name, description } = req.body as { name?: string; description?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: 'Project name is required' });
    return;
  }
  const project = await mutateDb((db) => {
    const item = {
      id: db.nextIds.project++,
      userId: 1,
      name: name.trim(),
      description: (description ?? '').trim(),
      createdAt: new Date().toISOString(),
    };
    db.projects.push(item);
    return item;
  });
  res.status(201).json(project);
});

app.post('/api/videos/demo', async (req, res) => {
  try {
    // Gemini disabled by default
    const useAi = req.body?.useAi === true;
    const projectId = Number(req.body?.projectId) || 1;
    const demo = await processingQueue.run(() => generateDemoPodcastVideo());
    const meta = await analyzeVideo(demo.filePath);

    const { video, job } = await mutateDb((db) => {
      const videoId = db.nextIds.video++;
      const v = {
        id: videoId,
        projectId,
        title: 'ClipForge Architecture Podcast (Ep. 04)',
        filename: demo.filename,
        originalName: 'demo-podcast-ep04.mp4',
        fileUrl: `/storage/uploads/${demo.filename}`,
        thumbnailUrl: null as string | null,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        fps: meta.fps,
        hasAudio: meta.hasAudio,
        sizeBytes: demo.sizeBytes,
        status: 'processing' as const,
        createdAt: new Date().toISOString(),
      };
      db.videos.push(v);

      const jobId = db.nextIds.job++;
      const j = {
        id: jobId,
        projectId,
        videoId,
        stage: 'queued' as const,
        progress: 8,
        message: 'Queued demo podcast video for deterministic clipping...',
        useAi,
        updatedAt: new Date().toISOString(),
      };
      db.processingJobs.push(j);
      return { video: v, job: j };
    });

    const thumbUrl = await generateThumbnail(
      demo.filePath,
      `video-${video.id}-cover.jpg`,
      2.0
    );
    if (thumbUrl) {
      await mutateDb((db) => {
        const target = db.videos.find((item) => item.id === video.id);
        if (target) target.thumbnailUrl = thumbUrl;
      });
    }

    void runVideoPipeline({
      videoId: video.id,
      jobId: job.id,
      useAi,
      presetSegments: SAMPLE_PODCAST_SEGMENTS,
      transcriptSource: 'sample',
    });

    res.status(201).json({ video, job });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create demo video';
    res.status(500).json({ error: message });
  }
});

app.post('/api/videos/upload', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Please attach a valid video file (.mp4, .mov, .webm, .mkv).' });
      return;
    }

    const metaCheck = validateUploadedFileMeta(req.file);
    if (!metaCheck.valid) {
      safeUnlink(req.file.path);
      res.status(400).json({ error: metaCheck.error });
      return;
    }

    let videoMeta;
    try {
      videoMeta = await analyzeVideo(req.file.path);
    } catch (probeErr) {
      safeUnlink(req.file.path);
      res.status(400).json({
        error:
          probeErr instanceof Error
            ? probeErr.message
            : 'Invalid or corrupted video file.',
      });
      return;
    }

    const title =
      (req.body.title as string | undefined)?.trim().slice(0, 120) ||
      req.file.originalname.replace(/\.[^.]+$/, '');
    const projectId = Number(req.body.projectId) || 1;
    // Gemini disabled by default
    const useAi = req.body.useAi === 'true' || req.body.useAi === true;
    const transcriptText = (req.body.transcriptText as string | undefined) ?? '';

    const { video, job } = await mutateDb((db) => {
      const videoId = db.nextIds.video++;
      const v = {
        id: videoId,
        projectId,
        title,
        filename: req.file!.filename,
        originalName: path.basename(req.file!.originalname),
        fileUrl: `/storage/uploads/${req.file!.filename}`,
        thumbnailUrl: null as string | null,
        duration: videoMeta.duration,
        width: videoMeta.width,
        height: videoMeta.height,
        fps: videoMeta.fps,
        hasAudio: videoMeta.hasAudio,
        sizeBytes: req.file!.size,
        status: 'processing' as const,
        createdAt: new Date().toISOString(),
      };
      db.videos.push(v);

      const jobId = db.nextIds.job++;
      const j = {
        id: jobId,
        projectId,
        videoId,
        stage: 'queued' as const,
        progress: 10,
        message: 'Video validated & queued for sequential processing...',
        useAi,
        updatedAt: new Date().toISOString(),
      };
      db.processingJobs.push(j);
      return { video: v, job: j };
    });

    const thumbUrl = await generateThumbnail(
      req.file.path,
      `video-${video.id}-cover.jpg`,
      Math.min(2, Math.max(0.2, videoMeta.duration * 0.15))
    );
    if (thumbUrl) {
      await mutateDb((db) => {
        const target = db.videos.find((item) => item.id === video.id);
        if (target) target.thumbnailUrl = thumbUrl;
      });
    }

    void runVideoPipeline({
      videoId: video.id,
      jobId: job.id,
      useAi,
      suppliedTranscript: transcriptText,
    });

    res.status(201).json({ video, job });
  } catch (err) {
    if (req.file?.path) safeUnlink(req.file.path);
    const message = err instanceof Error ? err.message : 'Upload failed';
    res.status(500).json({ error: message });
  }
});

app.post('/api/videos/:id/retry', async (req, res) => {
  const videoId = Number(req.params.id);
  const useAi = req.body?.useAi === true;
  const db = readDb();
  const video = db.videos.find((v) => v.id === videoId);
  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  const existingTranscript = db.transcriptions.find((t) => t.videoId === videoId);
  const job = await mutateDb((state) => {
    const j = {
      id: state.nextIds.job++,
      projectId: video.projectId,
      videoId,
      stage: 'queued' as const,
      progress: 10,
      message: 'Retrying video pipeline in sequential queue...',
      useAi,
      updatedAt: new Date().toISOString(),
    };
    state.processingJobs.push(j);
    const target = state.videos.find((v) => v.id === videoId);
    if (target) {
      target.status = 'processing';
      target.errorMessage = undefined;
    }
    return j;
  });

  void runVideoPipeline({
    videoId,
    jobId: job.id,
    useAi,
    presetSegments: existingTranscript?.segments,
    transcriptSource: existingTranscript?.source,
  });

  res.json({ job });
});

app.post('/api/videos/:id/process', async (req, res) => {
  const videoId = Number(req.params.id);
  const { useAi = false, transcriptText } = req.body as {
    useAi?: boolean;
    transcriptText?: string;
  };
  const db = readDb();
  const video = db.videos.find((v) => v.id === videoId);
  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  const existingTranscript = db.transcriptions.find((t) => t.videoId === videoId);

  const job = await mutateDb((state) => {
    const j = {
      id: state.nextIds.job++,
      projectId: video.projectId,
      videoId,
      stage: 'queued' as const,
      progress: 10,
      message: 'Re-running moment detection pipeline...',
      useAi,
      updatedAt: new Date().toISOString(),
    };
    state.processingJobs.push(j);
    return j;
  });

  void runVideoPipeline({
    videoId,
    jobId: job.id,
    useAi,
    suppliedTranscript: transcriptText,
    presetSegments: !transcriptText && existingTranscript ? existingTranscript.segments : undefined,
    transcriptSource: existingTranscript?.source,
  });

  res.json({ job });
});

app.get('/api/jobs/:videoId', (req, res) => {
  const videoId = Number(req.params.videoId);
  const db = readDb();
  const jobs = db.processingJobs.filter((j) => j.videoId === videoId);
  const latest = jobs[jobs.length - 1] ?? null;
  res.json({ job: latest });
});

app.delete('/api/videos/:id', async (req, res) => {
  const videoId = Number(req.params.id);
  const db = readDb();
  const video = db.videos.find((v) => v.id === videoId);
  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  safeUnlink(path.join(UPLOADS_DIR, path.basename(video.filename)));

  await mutateDb((state) => {
    state.videos = state.videos.filter((v) => v.id !== videoId);
    state.transcriptions = state.transcriptions.filter((t) => t.videoId !== videoId);
    state.clips = state.clips.filter((c) => c.videoId !== videoId);
    state.processingJobs = state.processingJobs.filter((j) => j.videoId !== videoId);
  });

  res.json({ ok: true });
});

app.patch('/api/transcriptions/:videoId', async (req, res) => {
  const videoId = Number(req.params.videoId);
  const { segments } = req.body as { segments?: TranscriptSegment[] };
  if (!Array.isArray(segments)) {
    res.status(400).json({ error: 'segments array is required' });
    return;
  }
  const updated = await mutateDb((db) => {
    const existing = db.transcriptions.find((t) => t.videoId === videoId);
    if (!existing) return null;
    existing.segments = segments;
    return existing;
  });
  if (!updated) {
    res.status(404).json({ error: 'Transcription not found for this video' });
    return;
  }
  res.json(updated);
});

app.post('/api/transcriptions/:videoId/import-srt', srtUpload.single('srt'), async (req, res) => {
  const videoId = Number(req.params.videoId);
  const db = readDb();
  const video = db.videos.find((v) => v.id === videoId);
  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  const rawSrt = req.file
    ? req.file.buffer.toString('utf-8')
    : typeof req.body?.srtText === 'string'
    ? req.body.srtText
    : '';

  if (!rawSrt.trim()) {
    res.status(400).json({ error: 'Please attach an .srt file or provide srtText.' });
    return;
  }

  const segments = parseSrtFileContent(rawSrt);
  if (segments.length === 0) {
    res.status(400).json({
      error: 'No valid SRT cue blocks found (expected format: 00:00:01,000 --> 00:00:04,000).',
    });
    return;
  }

  const transcription = await mutateDb((state) => {
    const existing = state.transcriptions.find((t) => t.videoId === videoId);
    if (existing) {
      existing.segments = segments;
      existing.source = 'srt';
      return existing;
    }
    const created = {
      id: state.nextIds.transcription++,
      videoId,
      source: 'srt' as const,
      language: 'auto',
      segments,
      createdAt: new Date().toISOString(),
    };
    state.transcriptions.push(created);
    return created;
  });

  res.json({ transcription, importedCount: segments.length });
});

app.post('/api/clips', async (req, res) => {
  const { videoId, startTime, endTime, title } = req.body as {
    videoId: number;
    startTime: number;
    endTime: number;
    title?: string;
  };
  const db = readDb();
  const video = db.videos.find((v) => v.id === videoId);
  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  const start = Math.max(0, Math.min(video.duration - 2, Number(startTime) || 0));
  const end = Math.max(start + 2, Math.min(video.duration, Number(endTime) || start + 15));
  const trans = db.transcriptions.find((t) => t.videoId === videoId);
  const segsInRange = (trans?.segments ?? []).filter(
    (s) => s.end > start && s.start < end
  );
  const scored = scoreWindow(
    segsInRange.length > 0
      ? segsInRange
      : [{ id: 'manual', start, end, text: title || 'Custom segment' }],
    db.scoringConfig
  );

  const nextId = db.nextIds.clip;
  const videoPath = path.join(UPLOADS_DIR, path.basename(video.filename));
  const thumbUrl = await generateThumbnail(
    videoPath,
    `clip-${nextId}-preview.jpg`,
    (start + end) / 2
  );

  const clip = await mutateDb((state) => {
    const clipId = state.nextIds.clip++;
    const item: ClipRecord = {
      id: clipId,
      videoId,
      title: title?.trim() || scored.title,
      hookText: scored.hookText,
      hookType: scored.hookType,
      contextStatus: scored.contextStatus,
      sceneChanges: scored.sceneChanges,
      startTime: Math.round(start * 100) / 100,
      endTime: Math.round(end * 100) / 100,
      score: scored.score,
      breakdown: scored.breakdown,
      reason: scored.reason,
      scoringSource: 'manual',
      status: 'approved',
      aspectRatio: '9:16',
      framingMode: 'crop',
      cropX: 50,
      cropY: 50,
      zoom: 1.0,
      subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
      exportedUrl: null,
      srtUrl: null,
      thumbnailUrl: thumbUrl ?? video.thumbnailUrl,
      createdAt: new Date().toISOString(),
    };
    state.clips.push(item);
    return item;
  });

  res.status(201).json(clip);
});

app.patch('/api/clips/:id', async (req, res) => {
  const clipId = Number(req.params.id);
  const patch = req.body as Partial<ClipRecord>;

  const updated = await mutateDb((db) => {
    const clip = db.clips.find((c) => c.id === clipId);
    if (!clip) return null;

    if (typeof patch.title === 'string') clip.title = patch.title;
    if (typeof patch.startTime === 'number') clip.startTime = Math.max(0, patch.startTime);
    if (typeof patch.endTime === 'number')
      clip.endTime = Math.max(clip.startTime + 1, patch.endTime);
    if (patch.status) clip.status = patch.status;
    if (patch.aspectRatio) clip.aspectRatio = patch.aspectRatio;
    if (patch.framingMode) clip.framingMode = patch.framingMode;
    if (typeof patch.cropX === 'number') clip.cropX = Math.min(100, Math.max(0, patch.cropX));
    if (typeof patch.cropY === 'number') clip.cropY = Math.min(100, Math.max(0, patch.cropY));
    if (typeof patch.zoom === 'number') clip.zoom = Math.min(2, Math.max(1, patch.zoom));
    if (patch.subtitleStyle) {
      clip.subtitleStyle = { ...clip.subtitleStyle, ...patch.subtitleStyle };
    }
    return clip;
  });

  if (!updated) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  res.json(updated);
});

app.post('/api/clips/:id/rescore', async (req, res) => {
  try {
    const clipId = Number(req.params.id);
    const useAi = req.body?.useAi === true;
    const db = readDb();
    const clip = db.clips.find((c) => c.id === clipId);
    if (!clip) {
      res.status(404).json({ error: 'Clip not found' });
      return;
    }
    const trans = db.transcriptions.find((t) => t.videoId === clip.videoId);
    const segsInRange = (trans?.segments ?? []).filter(
      (s) => s.end > clip.startTime && s.start < clip.endTime
    );
    const segs =
      segsInRange.length > 0
        ? segsInRange
        : [{ id: 'range', start: clip.startTime, end: clip.endTime, text: clip.title }];

    const heuristicResult = scoreWindow(segs, db.scoringConfig);
    let finalScore = heuristicResult.score;
    let finalBreakdown = heuristicResult.breakdown;
    let finalReason = heuristicResult.reason;
    let finalHookText = heuristicResult.hookText;
    let scoringSource: 'heuristic' | 'gemini' = 'heuristic';

    if (useAi && isGeminiConfigured()) {
      try {
        const evaluated = await refineCandidatesWithGemini(
          [
            {
              title: clip.title,
              hookText: heuristicResult.hookText,
              hookType: heuristicResult.hookType,
              contextStatus: heuristicResult.contextStatus,
              sceneChanges: heuristicResult.sceneChanges,
              startTime: clip.startTime,
              endTime: clip.endTime,
              score: heuristicResult.score,
              breakdown: heuristicResult.breakdown,
              reason: heuristicResult.reason,
              transcriptExcerpt: segs.map((s) => s.text).join(' '),
            },
          ],
          db.scoringConfig
        );
        if (evaluated[0]) {
          finalScore = evaluated[0].score;
          finalBreakdown = evaluated[0].breakdown;
          finalReason = evaluated[0].reason;
          finalHookText = evaluated[0].hookText;
          scoringSource = 'gemini';
        }
      } catch {
        // Deterministic fallback if Gemini fails
        finalReason = `${heuristicResult.reason} (Gemini fallback -> heuristic)`;
      }
    }

    const updated = await mutateDb((state) => {
      const target = state.clips.find((c) => c.id === clipId);
      if (!target) return null;
      target.score = finalScore;
      target.breakdown = finalBreakdown;
      target.reason = finalReason;
      target.hookText = finalHookText;
      target.hookType = heuristicResult.hookType;
      target.contextStatus = heuristicResult.contextStatus;
      target.scoringSource = scoringSource;
      return target;
    });

    res.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Rescore failed';
    res.status(500).json({ error: message });
  }
});

app.post('/api/clips/:id/compile', async (req, res) => {
  try {
    const clipId = Number(req.params.id);
    const db = readDb();
    const clip = db.clips.find((c) => c.id === clipId);
    if (!clip) {
      res.status(404).json({ error: 'Clip not found' });
      return;
    }
    const video = db.videos.find((v) => v.id === clip.videoId);
    if (!video) {
      res.status(404).json({ error: 'Source video not found' });
      return;
    }
    const trans = db.transcriptions.find((t) => t.videoId === clip.videoId);
    const videoPath = path.join(UPLOADS_DIR, path.basename(video.filename));

    // Serialize heavy FFmpeg rendering through the single-worker queue
    const rendered = await processingQueue.run(() =>
      renderClipWithFfmpeg({
        clip,
        videoPath,
        hasAudio: video.hasAudio,
        segments: trans?.segments ?? [],
      })
    );

    const updated = await mutateDb((state) => {
      const target = state.clips.find((c) => c.id === clipId);
      if (!target) return null;
      target.exportedUrl = rendered.exportedUrl;
      target.srtUrl = rendered.srtUrl;
      target.exportedSizeBytes = rendered.exportedSizeBytes;
      if (rendered.thumbnailUrl) target.thumbnailUrl = rendered.thumbnailUrl;
      target.status = 'exported';
      return target;
    });

    res.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'FFmpeg compilation failed';
    res.status(500).json({ error: message });
  }
});

app.get('/api/clips/:id/download', (req, res) => {
  const clipId = Number(req.params.id);
  const format = req.query.format === 'srt' ? 'srt' : 'mp4';
  const db = readDb();
  const clip = db.clips.find((c) => c.id === clipId);
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }

  const targetUrl = format === 'srt' ? clip.srtUrl : clip.exportedUrl;
  if (!targetUrl) {
    res.status(400).json({ error: 'Clip has not been compiled yet. Click Compile & Export first.' });
    return;
  }

  const filename = path.basename(targetUrl);
  const fullPath = path.join(CLIPS_DIR, filename);
  if (!fs.existsSync(fullPath)) {
    res.status(404).json({ error: 'Rendered file missing on disk. Recompile the clip.' });
    return;
  }

  const safeDownloadName =
    clip.title.replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase().slice(0, 48) || `clip-${clip.id}`;
  res.download(fullPath, `${safeDownloadName}.${format}`);
});

app.delete('/api/clips/:id', async (req, res) => {
  const clipId = Number(req.params.id);
  await mutateDb((db) => {
    db.clips = db.clips.filter((c) => c.id !== clipId);
  });
  res.json({ ok: true });
});

app.put('/api/scoring-config', async (req, res) => {
  const patch = req.body as Partial<ScoringConfig>;
  const updated = await mutateDb((db) => {
    db.scoringConfig = { ...db.scoringConfig, ...patch };
    return db.scoringConfig;
  });
  res.json(updated);
});

app.post('/api/scoring-lab/test', (req, res) => {
  const { transcript, config } = req.body as {
    transcript?: string;
    config?: ScoringConfig;
  };
  if (!transcript?.trim()) {
    res.status(400).json({ error: 'Provide transcript or SRT text to evaluate.' });
    return;
  }
  const db = readDb();
  const activeConfig = config ?? db.scoringConfig;
  const segments = parseSrtOrTextTranscript(transcript, 120);
  const candidates = detectCandidateClipsHeuristic(segments, activeConfig);
  res.json({ segments, candidates });
});

app.post('/api/storage/cleanup', (_req, res) => {
  let removed = 0;
  if (fs.existsSync(TRANSCRIPTS_DIR)) {
    for (const file of fs.readdirSync(TRANSCRIPTS_DIR)) {
      safeUnlink(path.join(TRANSCRIPTS_DIR, file));
      removed++;
    }
  }
  res.json({ ok: true, removed, storageBytes: getStorageUsageBytes() });
});

// Express error handler for multer / upload validation errors
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (err instanceof Error) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
);

async function startServer() {
  const port = Number(process.env.PORT) || 3000;
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd) {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.use((_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`ClipForge server running on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start ClipForge server:', err);
  process.exit(1);
});
