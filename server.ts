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
  STORAGE_ROOT,
  TRANSCRIPTS_DIR,
  UPLOADS_DIR,
  ensureStorageDirs,
  getStorageUsageBytes,
  readDb,
  writeDb,
} from './server/db';
import { runVideoPipeline } from './server/pipeline';
import {
  detectCandidateClipsHeuristic,
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
  analyzeVideo,
  checkFfmpegBinaries,
  generateThumbnail,
} from './server/processing/videoAnalyzer';

ensureStorageDirs();

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Serve generated uploads, thumbnails, and compiled clips with Range request support
app.use('/storage', express.static(STORAGE_ROOT));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureStorageDirs();
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    const base = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 40);
    cb(null, `${Date.now()}-${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 250 * 1024 * 1024 },
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'clipforge' });
});

app.get('/api/status', async (_req, res) => {
  const binaries = await checkFfmpegBinaries();
  const db = readDb();
  res.json({
    ffmpegAvailable: binaries.ffmpegAvailable,
    ffprobeAvailable: binaries.ffprobeAvailable,
    geminiConfigured: isGeminiConfigured(),
    storageBytes: getStorageUsageBytes(),
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

app.post('/api/projects', (req, res) => {
  const { name, description } = req.body as { name?: string; description?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: 'Project name is required' });
    return;
  }
  const db = readDb();
  const project = {
    id: db.nextIds.project++,
    userId: 1,
    name: name.trim(),
    description: (description ?? '').trim(),
    createdAt: new Date().toISOString(),
  };
  db.projects.push(project);
  writeDb(db);
  res.status(201).json(project);
});

app.post('/api/videos/demo', async (req, res) => {
  try {
    const useAi = Boolean(req.body?.useAi);
    const projectId = Number(req.body?.projectId) || 1;
    const demo = await generateDemoPodcastVideo();
    const meta = await analyzeVideo(demo.filePath);

    const db = readDb();
    const videoId = db.nextIds.video++;
    const thumbUrl = await generateThumbnail(
      demo.filePath,
      `video-${videoId}-cover.jpg`,
      2.0
    );

    const video = {
      id: videoId,
      projectId,
      title: 'ClipForge Architecture Podcast (Ep. 04)',
      filename: demo.filename,
      originalName: 'demo-podcast-ep04.mp4',
      fileUrl: `/storage/uploads/${demo.filename}`,
      thumbnailUrl: thumbUrl,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      hasAudio: meta.hasAudio,
      sizeBytes: demo.sizeBytes,
      status: 'processing' as const,
      createdAt: new Date().toISOString(),
    };
    db.videos.push(video);

    const jobId = db.nextIds.job++;
    const job = {
      id: jobId,
      projectId,
      videoId,
      stage: 'queued' as const,
      progress: 8,
      message: 'Queued demo podcast video for deterministic clipping...',
      useAi,
      updatedAt: new Date().toISOString(),
    };
    db.processingJobs.push(job);
    writeDb(db);

    void runVideoPipeline({
      videoId,
      jobId,
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
      res.status(400).json({ error: 'Please attach a video file (.mp4, .mov, .webm, .mkv).' });
      return;
    }

    const title = (req.body.title as string | undefined)?.trim() || req.file.originalname.replace(/\.[^.]+$/, '');
    const projectId = Number(req.body.projectId) || 1;
    const useAi = req.body.useAi === 'true' || req.body.useAi === true;
    const transcriptText = (req.body.transcriptText as string | undefined) ?? '';

    const meta = await analyzeVideo(req.file.path);
    const db = readDb();
    const videoId = db.nextIds.video++;
    const thumbUrl = await generateThumbnail(
      req.file.path,
      `video-${videoId}-cover.jpg`,
      Math.min(2, Math.max(0.2, meta.duration * 0.15))
    );

    const video = {
      id: videoId,
      projectId,
      title,
      filename: req.file.filename,
      originalName: req.file.originalname,
      fileUrl: `/storage/uploads/${req.file.filename}`,
      thumbnailUrl: thumbUrl,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      hasAudio: meta.hasAudio,
      sizeBytes: req.file.size,
      status: 'processing' as const,
      createdAt: new Date().toISOString(),
    };
    db.videos.push(video);

    const jobId = db.nextIds.job++;
    const job = {
      id: jobId,
      projectId,
      videoId,
      stage: 'queued' as const,
      progress: 10,
      message: 'Video uploaded. Starting analysis pipeline...',
      useAi,
      updatedAt: new Date().toISOString(),
    };
    db.processingJobs.push(job);
    writeDb(db);

    void runVideoPipeline({
      videoId,
      jobId,
      useAi,
      suppliedTranscript: transcriptText,
    });

    res.status(201).json({ video, job });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed';
    res.status(500).json({ error: message });
  }
});

app.post('/api/videos/:id/process', (req, res) => {
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

  const jobId = db.nextIds.job++;
  const job = {
    id: jobId,
    projectId: video.projectId,
    videoId,
    stage: 'queued' as const,
    progress: 10,
    message: 'Re-running moment detection pipeline...',
    useAi,
    updatedAt: new Date().toISOString(),
  };
  db.processingJobs.push(job);
  writeDb(db);

  void runVideoPipeline({
    videoId,
    jobId,
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

app.delete('/api/videos/:id', (req, res) => {
  const videoId = Number(req.params.id);
  const db = readDb();
  const video = db.videos.find((v) => v.id === videoId);
  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  const uploadPath = path.join(UPLOADS_DIR, video.filename);
  if (fs.existsSync(uploadPath)) {
    try {
      fs.unlinkSync(uploadPath);
    } catch {
      // ignore
    }
  }

  db.videos = db.videos.filter((v) => v.id !== videoId);
  db.transcriptions = db.transcriptions.filter((t) => t.videoId !== videoId);
  db.clips = db.clips.filter((c) => c.videoId !== videoId);
  db.processingJobs = db.processingJobs.filter((j) => j.videoId !== videoId);
  writeDb(db);
  res.json({ ok: true });
});

app.patch('/api/transcriptions/:videoId', (req, res) => {
  const videoId = Number(req.params.videoId);
  const { segments } = req.body as { segments?: TranscriptSegment[] };
  if (!Array.isArray(segments)) {
    res.status(400).json({ error: 'segments array is required' });
    return;
  }
  const db = readDb();
  const existing = db.transcriptions.find((t) => t.videoId === videoId);
  if (!existing) {
    res.status(404).json({ error: 'Transcription not found for this video' });
    return;
  }
  existing.segments = segments;
  writeDb(db);
  res.json(existing);
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

  const clipId = db.nextIds.clip++;
  const videoPath = path.join(UPLOADS_DIR, video.filename);
  const thumbUrl = await generateThumbnail(
    videoPath,
    `clip-${clipId}-preview.jpg`,
    (start + end) / 2
  );

  const clip: ClipRecord = {
    id: clipId,
    videoId,
    title: title?.trim() || scored.title,
    hookText: scored.hookText,
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

  db.clips.push(clip);
  writeDb(db);
  res.status(201).json(clip);
});

app.patch('/api/clips/:id', (req, res) => {
  const clipId = Number(req.params.id);
  const db = readDb();
  const clip = db.clips.find((c) => c.id === clipId);
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }

  const patch = req.body as Partial<ClipRecord>;
  if (typeof patch.title === 'string') clip.title = patch.title;
  if (typeof patch.startTime === 'number') clip.startTime = Math.max(0, patch.startTime);
  if (typeof patch.endTime === 'number') clip.endTime = Math.max(clip.startTime + 1, patch.endTime);
  if (patch.status) clip.status = patch.status;
  if (patch.aspectRatio) clip.aspectRatio = patch.aspectRatio;
  if (patch.framingMode) clip.framingMode = patch.framingMode;
  if (typeof patch.cropX === 'number') clip.cropX = Math.min(100, Math.max(0, patch.cropX));
  if (typeof patch.cropY === 'number') clip.cropY = Math.min(100, Math.max(0, patch.cropY));
  if (typeof patch.zoom === 'number') clip.zoom = Math.min(2, Math.max(1, patch.zoom));
  if (patch.subtitleStyle) {
    clip.subtitleStyle = { ...clip.subtitleStyle, ...patch.subtitleStyle };
  }

  writeDb(db);
  res.json(clip);
});

app.post('/api/clips/:id/rescore', async (req, res) => {
  try {
    const clipId = Number(req.params.id);
    const useAi = Boolean(req.body?.useAi);
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

    if (useAi) {
      const evaluated = await refineCandidatesWithGemini(
        [
          {
            title: clip.title,
            hookText: clip.hookText,
            startTime: clip.startTime,
            endTime: clip.endTime,
            score: clip.score,
            breakdown: clip.breakdown,
            reason: clip.reason,
            transcriptExcerpt: segs.map((s) => s.text).join(' '),
          },
        ],
        db.scoringConfig
      );
      if (evaluated[0]) {
        clip.score = evaluated[0].score;
        clip.breakdown = evaluated[0].breakdown;
        clip.reason = evaluated[0].reason;
        clip.hookText = evaluated[0].hookText;
        clip.scoringSource = 'gemini';
      }
    } else {
      const result = scoreWindow(segs, db.scoringConfig);
      clip.score = result.score;
      clip.breakdown = result.breakdown;
      clip.reason = result.reason;
      clip.hookText = result.hookText;
      clip.scoringSource = 'heuristic';
    }

    writeDb(db);
    res.json(clip);
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
    const videoPath = path.join(UPLOADS_DIR, video.filename);

    const rendered = await renderClipWithFfmpeg({
      clip,
      videoPath,
      hasAudio: video.hasAudio,
      segments: trans?.segments ?? [],
    });

    clip.exportedUrl = rendered.exportedUrl;
    clip.srtUrl = rendered.srtUrl;
    clip.exportedSizeBytes = rendered.exportedSizeBytes;
    if (rendered.thumbnailUrl) clip.thumbnailUrl = rendered.thumbnailUrl;
    clip.status = 'exported';

    writeDb(db);
    res.json(clip);
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

app.delete('/api/clips/:id', (req, res) => {
  const clipId = Number(req.params.id);
  const db = readDb();
  db.clips = db.clips.filter((c) => c.id !== clipId);
  writeDb(db);
  res.json({ ok: true });
});

app.put('/api/scoring-config', (req, res) => {
  const patch = req.body as Partial<ScoringConfig>;
  const db = readDb();
  db.scoringConfig = { ...db.scoringConfig, ...patch };
  writeDb(db);
  res.json(db.scoringConfig);
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
      try {
        fs.unlinkSync(path.join(TRANSCRIPTS_DIR, file));
        removed++;
      } catch {
        // ignore
      }
    }
  }
  res.json({ ok: true, removed, storageBytes: getStorageUsageBytes() });
});

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
