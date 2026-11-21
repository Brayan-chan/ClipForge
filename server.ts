import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createServer as createViteServer } from 'vite';
import type { ClipRecord, ScoringConfig, TranscriptSegment } from './src/types';
import { ensureClipCompositions, type CompositionVariant } from './src/utils/composition';
import {
  CLIPS_DIR,
  DEFAULT_SUBTITLE_STYLE,
  STORAGE_ROOT,
  THUMBNAILS_DIR,
  TRANSCRIPTS_DIR,
  UPLOADS_DIR,
  ensureStorageDirs,
  getStorageUsageBytes,
  mutateDb,
  readDb,
  recoverInterruptedJobs,
  resolveVideoInputSource,
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
  abortMultipartObjectUpload,
  buildReadableObjectUrl,
  completeMultipartObjectUpload,
  createMultipartObjectUpload,
  createMultipartPartUrl,
  deleteObjectStorageKeys,
  downloadObjectStorageKeyToTemp,
  createPresignedObjectUrl,
  isObjectStorageConfigured,
  objectKeyFromUrl,
  uploadLocalFileToObjectStorage,
} from './server/processing/objectStorage';
import {
  UrlIngestionError,
  ingestYouTubeUrl,
  probeRemoteDirectUrl,
} from './server/processing/urlIngestor';
import {
  MAX_VIDEO_SIZE_BYTES,
  formatUploadLimitLabel,
  generateSafeMediaFilename,
  hasEnoughDiskSpace,
  isYouTubeUrl,
  safeUnlink,
  validateSafeHttpUrl,
  validateUploadedFileMeta,
} from './server/processing/validation';
import {
  analyzeVideo,
  checkFfmpegBinaries,
  generateThumbnail,
} from './server/processing/videoAnalyzer';
import {
  clipSubtitleDocumentId,
  deleteSubtitleText,
  isFirestoreSubtitlesConfigured,
  readSubtitleText,
} from './server/processing/firestoreSubtitles';
import {
  deleteCloudinaryImage,
  isCloudinaryConfigured,
} from './server/processing/cloudinaryImages';

try {
  process.loadEnvFile?.();
} catch {
  // Environment variables may already be supplied by the shell/host.
}

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

app.get(/^\/api\/media\/(.+)$/, (req, res) => {
  if (!isObjectStorageConfigured()) {
    res.status(503).json({ error: 'R2 object storage is not configured.' });
    return;
  }
  const rawKey = String(req.params[0] ?? '');
  let key = '';
  try {
    key = rawKey.split('/').map((part) => decodeURIComponent(part)).join('/');
  } catch {
    res.status(400).json({ error: 'Invalid media key.' });
    return;
  }
  if (!/^(uploads|clips|subtitles|thumbnails)\//.test(key) || key.includes('..')) {
    res.status(400).json({ error: 'Invalid media key.' });
    return;
  }
  res.redirect(307, buildReadableObjectUrl(key));
});

app.get('/api/subtitles/:documentId', async (req, res) => {
  const documentId = req.params.documentId;
  if (!/^clip-\d+-(vertical|horizontal)$/.test(documentId)) {
    res.status(400).json({ error: 'Invalid subtitle document.' });
    return;
  }
  const srt = await readSubtitleText(documentId);
  if (srt === null) {
    res.status(404).json({ error: 'Subtitle document not found.' });
    return;
  }
  res.type('application/x-subrip; charset=utf-8').send(srt);
});

function removeClipArtifactsByIds(clipIds: Iterable<number>): number {
  const ids = new Set(clipIds);
  if (ids.size === 0) return 0;
  let removed = 0;
  for (const dir of [CLIPS_DIR, THUMBNAILS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const filename of fs.readdirSync(dir)) {
      const match = filename.match(/^clip-(\d+)-/);
      if (!match || !ids.has(Number(match[1]))) continue;
      safeUnlink(path.join(dir, filename));
      removed++;
    }
  }
  return removed;
}

async function deleteCloudinaryKeys(keys: Iterable<string>): Promise<number> {
  if (!isCloudinaryConfigured()) return 0;
  let removed = 0;
  for (const key of new Set(keys)) {
    if (key.startsWith('clipforge/') && await deleteCloudinaryImage(key)) removed++;
  }
  return removed;
}

/** Removes renderer artifacts whose clip record no longer exists. */
function reconcileOrphanedClipArtifacts(): number {
  const liveIds = new Set(readDb().clips.map((clip) => clip.id));
  const orphanIds = new Set<number>();
  for (const dir of [CLIPS_DIR, THUMBNAILS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const filename of fs.readdirSync(dir)) {
      const match = filename.match(/^clip-(\d+)-/);
      if (match && !liveIds.has(Number(match[1]))) orphanIds.add(Number(match[1]));
    }
  }
  return removeClipArtifactsByIds(orphanIds);
}

interface CleanupReport {
  removedFiles: number;
  removedBytes: number;
}

function removeFileWithReport(filePath: string, report: CleanupReport): void {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return;
    fs.unlinkSync(filePath);
    report.removedFiles++;
    report.removedBytes += stat.size;
  } catch {
    // A cache file can disappear between the scan and deletion.
  }
}

function localBasename(url: string | null | undefined, prefix: string): string | null {
  if (!url?.startsWith(prefix)) return null;
  return path.basename(url);
}

/** Reconciles managed media folders against the database without touching live assets. */
function purgeUnreferencedStorage(): CleanupReport {
  const db = readDb();
  const report: CleanupReport = { removedFiles: 0, removedBytes: 0 };
  const referencedUploads = new Set(
    db.videos.filter((video) => !video.sourceUrl).map((video) => path.basename(video.filename))
  );
  const referencedClips = new Set<string>();
  const referencedThumbnails = new Set<string>();

  for (const video of db.videos) {
    const thumbnail = localBasename(video.thumbnailUrl, '/storage/thumbnails/');
    if (thumbnail) referencedThumbnails.add(thumbnail);
  }
  for (const clip of db.clips) {
    for (const url of [clip.exportedUrl, clip.srtUrl]) {
      const filename = localBasename(url, '/storage/clips/');
      if (filename) referencedClips.add(filename);
    }
    const thumbnail = localBasename(clip.thumbnailUrl, '/storage/thumbnails/');
    if (thumbnail) referencedThumbnails.add(thumbnail);
    for (const variant of Object.values(clip.exportVariants ?? {})) {
      for (const url of [variant?.exportedUrl, variant?.srtUrl]) {
        const filename = localBasename(url, '/storage/clips/');
        if (filename) referencedClips.add(filename);
      }
      const variantThumbnail = localBasename(variant?.thumbnailUrl, '/storage/thumbnails/');
      if (variantThumbnail) referencedThumbnails.add(variantThumbnail);
    }
  }

  const removeUnreferenced = (dir: string, keep: Set<string>) => {
    if (!fs.existsSync(dir)) return;
    for (const filename of fs.readdirSync(dir)) {
      if (!keep.has(filename)) removeFileWithReport(path.join(dir, filename), report);
    }
  };
  removeUnreferenced(UPLOADS_DIR, referencedUploads);
  removeUnreferenced(CLIPS_DIR, referencedClips);
  removeUnreferenced(THUMBNAILS_DIR, referencedThumbnails);

  // Reproducible intermediate files, never canonical user data.
  for (const dir of [TRANSCRIPTS_DIR, PREVIEWS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const filename of fs.readdirSync(dir)) {
      removeFileWithReport(path.join(dir, filename), report);
    }
  }
  if (fs.existsSync(CHUNKS_DIR)) {
    const activeChunkFiles = new Set(
      [...chunkUploadSessions.values()].map((session) => path.basename(session.tempPath))
    );
    for (const filename of fs.readdirSync(CHUNKS_DIR)) {
      if (!activeChunkFiles.has(filename)) {
        removeFileWithReport(path.join(CHUNKS_DIR, filename), report);
      }
    }
  }
  return report;
}

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

const CHUNKS_DIR = path.join(STORAGE_ROOT, '.chunks');
const UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024; // 5 MB chunks stay safely under proxy limits
const DEFAULT_CLIP_COUNT = 5;

function normalizeClipCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_CLIP_COUNT;
  return Math.max(1, Math.min(10, Math.round(parsed)));
}

interface ChunkUploadSession {
  uploadId: string;
  safeFilename: string;
  originalName: string;
  tempPath: string;
  expectedSizeBytes: number;
  receivedBytes: number;
  chunkSizes: Map<number, number>;
  title: string;
  projectId: number;
  useAi: boolean;
  editorOnly: boolean;
  requestedClipCount: number;
  transcriptText: string;
  createdAtMs: number;
  lastActivityMs: number;
  writeChain: Promise<void>;
}

const chunkUploadSessions = new Map<string, ChunkUploadSession>();

function cleanupExpiredChunkSessions(): void {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2 hours of inactivity
  for (const [id, session] of chunkUploadSessions.entries()) {
    if (session.lastActivityMs < cutoff) {
      safeUnlink(session.tempPath);
      chunkUploadSessions.delete(id);
    }
  }
}

async function finalizeUploadedVideo(params: {
  filePath: string;
  filename: string;
  originalName: string;
  sizeBytes: number;
  title: string;
  projectId: number;
  useAi: boolean;
  editorOnly: boolean;
  requestedClipCount: number;
  transcriptText: string;
  presetSegments?: TranscriptSegment[];
  transcriptSource?: 'gemini' | 'srt' | 'manual' | 'sample';
}) {
  let videoMeta;
  try {
    videoMeta = await analyzeVideo(params.filePath);
  } catch (probeErr) {
    safeUnlink(params.filePath);
    const err = new Error(
      probeErr instanceof Error ? probeErr.message : 'Invalid or corrupted video file.'
    ) as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }

  let storageKey: string | undefined;
  let remoteFileUrl: string | undefined;
  if (isObjectStorageConfigured()) {
    storageKey = `uploads/${params.filename}`;
    const extension = path.extname(params.filename).toLowerCase();
    const contentType = extension === '.webm'
      ? 'video/webm'
      : extension === '.mov'
      ? 'video/quicktime'
      : 'video/mp4';
    remoteFileUrl = await uploadLocalFileToObjectStorage({
      filePath: params.filePath,
      key: storageKey,
      contentType,
    });
    safeUnlink(params.filePath);
  }

  const { video, job } = await mutateDb((db) => {
    const videoId = db.nextIds.video++;
    const v = {
      id: videoId,
      projectId: params.projectId,
      title: params.title,
      filename: params.filename,
      originalName: path.basename(params.originalName),
      fileUrl: remoteFileUrl ?? `/storage/uploads/${params.filename}`,
      sourceUrl: storageKey ? `r2://${storageKey}` : undefined,
      storageKey,
      thumbnailUrl: null as string | null,
      duration: videoMeta.duration,
      width: videoMeta.width,
      height: videoMeta.height,
      fps: videoMeta.fps,
      hasAudio: videoMeta.hasAudio,
      sizeBytes: params.sizeBytes,
      status: 'processing' as const,
      createdAt: new Date().toISOString(),
    };
    db.videos.push(v);

    const jobId = db.nextIds.job++;
    const j = {
      id: jobId,
      projectId: params.projectId,
      videoId,
      stage: 'queued' as const,
      progress: 10,
      message: 'Video validated & queued for sequential processing...',
      useAi: params.useAi,
      editorOnly: params.editorOnly,
      requestedClipCount: params.requestedClipCount,
      updatedAt: new Date().toISOString(),
    };
    db.processingJobs.push(j);
    return { video: v, job: j };
  });

  void runVideoPipeline({
    videoId: video.id,
    jobId: job.id,
    useAi: params.useAi,
    editorOnly: params.editorOnly,
    requestedClipCount: params.requestedClipCount,
    suppliedTranscript: params.transcriptText,
    presetSegments: params.presetSegments,
    transcriptSource: params.transcriptSource,
  });

  return { video, job };
}

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
    maxUploadSizeBytes: MAX_VIDEO_SIZE_BYTES,
    objectStorageConfigured: isObjectStorageConfigured(),
    firestoreSubtitlesConfigured: isFirestoreSubtitlesConfigured(),
    cloudinaryConfigured: isCloudinaryConfigured(),
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
    const requestedClipCount = normalizeClipCount(req.body?.requestedClipCount);
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
        requestedClipCount,
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
      requestedClipCount,
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

    const title =
      (req.body.title as string | undefined)?.trim().slice(0, 120) ||
      req.file.originalname.replace(/\.[^.]+$/, '');
    const projectId = Number(req.body.projectId) || 1;
    const useAi = req.body.useAi === 'true' || req.body.useAi === true;
    const editorOnly = req.body.editorOnly === 'true' || req.body.editorOnly === true;
    const requestedClipCount = normalizeClipCount(req.body.requestedClipCount);
    const transcriptText = (req.body.transcriptText as string | undefined) ?? '';

    const result = await finalizeUploadedVideo({
      filePath: req.file.path,
      filename: req.file.filename,
      originalName: req.file.originalname,
      sizeBytes: req.file.size,
      title,
      projectId,
      useAi,
      editorOnly,
      requestedClipCount,
      transcriptText,
    });

    res.status(201).json(result);
  } catch (err) {
    if (req.file?.path) safeUnlink(req.file.path);
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    const message = err instanceof Error ? err.message : 'Upload failed';
    res.status(statusCode).json({ error: message });
  }
});

app.post('/api/videos/upload/init', (req, res) => {
  cleanupExpiredChunkSessions();
  const {
    filename,
    mimetype = 'video/mp4',
    sizeBytes,
    title,
    projectId,
    useAi = false,
    editorOnly = false,
    requestedClipCount = DEFAULT_CLIP_COUNT,
    transcriptText = '',
  } = req.body as {
    filename?: string;
    mimetype?: string;
    sizeBytes?: number;
    title?: string;
    projectId?: number;
    useAi?: boolean;
    editorOnly?: boolean;
    requestedClipCount?: number;
    transcriptText?: string;
  };

  if (!filename || typeof sizeBytes !== 'number' || sizeBytes <= 0) {
    res.status(400).json({ error: 'Invalid upload metadata.' });
    return;
  }

  const check = validateUploadedFileMeta({
    originalname: filename,
    mimetype,
    size: sizeBytes,
  });
  if (!check.valid) {
    res.status(400).json({ error: check.error });
    return;
  }

  const diskCheck = hasEnoughDiskSpace(sizeBytes, STORAGE_ROOT);
  if (!diskCheck.ok) {
    res.status(507).json({
      error: `Insufficient host disk space for this upload (available: ${(
        diskCheck.availableBytes /
        (1024 * 1024 * 1024)
      ).toFixed(1)} GB). Configure S3/R2 object storage or free disk space.`,
    });
    return;
  }

  fs.mkdirSync(CHUNKS_DIR, { recursive: true });
  const uploadId = crypto.randomUUID();
  const safeFilename = generateSafeMediaFilename(filename);
  const tempPath = path.join(CHUNKS_DIR, `${uploadId}.part`);
  fs.writeFileSync(tempPath, Buffer.alloc(0));

  const now = Date.now();
  chunkUploadSessions.set(uploadId, {
    uploadId,
    safeFilename,
    originalName: path.basename(filename),
    tempPath,
    expectedSizeBytes: sizeBytes,
    receivedBytes: 0,
    chunkSizes: new Map<number, number>(),
    title:
      (title ?? '').trim().slice(0, 120) ||
      path.basename(filename).replace(/\.[^.]+$/, ''),
    projectId: Number(projectId) || 1,
    useAi: useAi === true,
    editorOnly: editorOnly === true,
    requestedClipCount: normalizeClipCount(requestedClipCount),
    transcriptText: typeof transcriptText === 'string' ? transcriptText : '',
    createdAtMs: now,
    lastActivityMs: now,
    writeChain: Promise.resolve(),
  });

  res.status(201).json({
    uploadId,
    chunkSizeBytes: UPLOAD_CHUNK_BYTES,
    concurrency: 3,
  });
});

app.post(
  '/api/videos/upload/chunk/:uploadId',
  express.raw({ type: 'application/octet-stream', limit: '8mb' }),
  async (req, res) => {
    const session = chunkUploadSessions.get(req.params.uploadId);
    if (!session) {
      res.status(404).json({ error: 'Upload session not found or expired.' });
      return;
    }

    const chunk = req.body;
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
      res.status(400).json({ error: 'Empty upload chunk.' });
      return;
    }

    const rawIndex = req.query.index ?? req.headers['x-chunk-index'];
    const rawOffset = req.query.offset ?? req.headers['x-chunk-offset'];
    const hasPositionalArgs = rawIndex !== undefined && rawOffset !== undefined;
    const chunkIndex = hasPositionalArgs ? Number(rawIndex) : -1;
    const chunkOffset = hasPositionalArgs ? Number(rawOffset) : -1;

    if (
      hasPositionalArgs &&
      (!Number.isInteger(chunkIndex) ||
        chunkIndex < 0 ||
        !Number.isInteger(chunkOffset) ||
        chunkOffset < 0 ||
        chunkOffset + chunk.length > session.expectedSizeBytes ||
        chunkOffset + chunk.length > MAX_VIDEO_SIZE_BYTES)
    ) {
      res.status(400).json({ error: 'Invalid chunk index or byte offset.' });
      return;
    }

    if (!hasPositionalArgs && session.receivedBytes + chunk.length > MAX_VIDEO_SIZE_BYTES) {
      safeUnlink(session.tempPath);
      chunkUploadSessions.delete(session.uploadId);
      res.status(400).json({
        error: `Video exceeds maximum ${formatUploadLimitLabel()} limit.`,
      });
      return;
    }

    try {
      session.writeChain = session.writeChain.then(async () => {
        if (hasPositionalArgs) {
          const handle = await fs.promises.open(
            session.tempPath,
            fs.existsSync(session.tempPath) ? 'r+' : 'w+'
          );
          try {
            await handle.write(chunk, 0, chunk.length, chunkOffset);
          } finally {
            await handle.close();
          }
          session.chunkSizes.set(chunkIndex, chunk.length);
          let sum = 0;
          for (const sz of session.chunkSizes.values()) sum += sz;
          session.receivedBytes = sum;
        } else {
          await fs.promises.appendFile(session.tempPath, chunk);
          session.receivedBytes += chunk.length;
        }
        session.lastActivityMs = Date.now();
      });
      await session.writeChain;
      res.json({ ok: true, receivedBytes: session.receivedBytes });
    } catch (err) {
      safeUnlink(session.tempPath);
      chunkUploadSessions.delete(session.uploadId);
      const message = err instanceof Error ? err.message : 'Failed to write upload chunk.';
      res.status(500).json({ error: message });
    }
  }
);

app.post('/api/videos/upload/complete/:uploadId', async (req, res) => {
  const session = chunkUploadSessions.get(req.params.uploadId);
  if (!session) {
    res.status(404).json({ error: 'Upload session not found or expired.' });
    return;
  }
  chunkUploadSessions.delete(session.uploadId);

  try {
    await session.writeChain;
  } catch {
    // checked below
  }

  if (session.receivedBytes === 0 || !fs.existsSync(session.tempPath)) {
    safeUnlink(session.tempPath);
    res.status(400).json({ error: 'No video bytes were uploaded.' });
    return;
  }

  ensureStorageDirs();
  const finalPath = path.join(UPLOADS_DIR, session.safeFilename);
  try {
    await fs.promises.rename(session.tempPath, finalPath);
    const result = await finalizeUploadedVideo({
      filePath: finalPath,
      filename: session.safeFilename,
      originalName: session.originalName,
      sizeBytes: session.receivedBytes,
      title: session.title,
      projectId: session.projectId,
      useAi: session.useAi,
      editorOnly: session.editorOnly,
      requestedClipCount: session.requestedClipCount,
      transcriptText: session.transcriptText,
    });
    res.status(201).json(result);
  } catch (err) {
    safeUnlink(session.tempPath);
    safeUnlink(finalPath);
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    const message = err instanceof Error ? err.message : 'Failed to finalize uploaded video.';
    res.status(statusCode).json({ error: message });
  }
});

app.delete('/api/videos/upload/:uploadId', (req, res) => {
  const session = chunkUploadSessions.get(req.params.uploadId);
  if (session) {
    safeUnlink(session.tempPath);
    chunkUploadSessions.delete(session.uploadId);
  }
  res.json({ ok: true });
});

app.post('/api/uploads/presign', (req, res) => {
  if (!isObjectStorageConfigured()) {
    res.status(501).json({
      error: 'Direct S3/R2 object storage is not configured on this server.',
    });
    return;
  }

  const { filename, mimetype = 'video/mp4', sizeBytes } = req.body as {
    filename?: string;
    mimetype?: string;
    sizeBytes?: number;
  };

  if (!filename || typeof sizeBytes !== 'number' || sizeBytes <= 0) {
    res.status(400).json({ error: 'Invalid upload metadata.' });
    return;
  }

  const check = validateUploadedFileMeta({
    originalname: filename,
    mimetype,
    size: sizeBytes,
  });
  if (!check.valid) {
    res.status(400).json({ error: check.error });
    return;
  }

  const safeFilename = generateSafeMediaFilename(filename);
  const key = `uploads/${safeFilename}`;
  const putUrl = createPresignedObjectUrl({
    method: 'PUT',
    key,
    contentType: mimetype || 'video/mp4',
    expiresInSeconds: 3600,
  });

  res.status(201).json({ key, putUrl });
});

const MULTIPART_PART_SIZE_BYTES = 64 * 1024 * 1024;

function isSafeUploadKey(key: unknown): key is string {
  return typeof key === 'string' && key.startsWith('uploads/') && !key.includes('..');
}

app.post('/api/uploads/multipart/init', async (req, res) => {
  if (!isObjectStorageConfigured()) {
    res.status(501).json({ error: 'Object storage (S3/R2) is not configured.' });
    return;
  }
  try {
    const { filename, mimetype = 'video/mp4', sizeBytes } = req.body as {
      filename?: string;
      mimetype?: string;
      sizeBytes?: number;
    };
    if (!filename || typeof sizeBytes !== 'number' || sizeBytes <= 0) {
      res.status(400).json({ error: 'Invalid upload metadata.' });
      return;
    }
    const check = validateUploadedFileMeta({ originalname: filename, mimetype, size: sizeBytes });
    if (!check.valid) {
      res.status(400).json({ error: check.error });
      return;
    }
    const key = `uploads/${generateSafeMediaFilename(filename)}`;
    const uploadId = await createMultipartObjectUpload({ key, contentType: mimetype });
    res.status(201).json({ key, uploadId, partSizeBytes: MULTIPART_PART_SIZE_BYTES });
  } catch (err) {
    console.error('[r2] Could not initialize multipart upload:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Could not initialize upload.' });
  }
});

app.post('/api/uploads/multipart/part-url', async (req, res) => {
  try {
    const { key, uploadId, partNumber } = req.body as {
      key?: string;
      uploadId?: string;
      partNumber?: number;
    };
    if (!isSafeUploadKey(key) || !uploadId || !Number.isInteger(partNumber) || partNumber! < 1 || partNumber! > 10_000) {
      res.status(400).json({ error: 'Invalid multipart upload part.' });
      return;
    }
    const putUrl = await createMultipartPartUrl({ key, uploadId, partNumber: partNumber! });
    res.json({ putUrl });
  } catch (err) {
    console.error('[r2] Could not sign multipart part:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Could not sign upload part.' });
  }
});

app.post('/api/uploads/multipart/complete', async (req, res) => {
  try {
    const { key, uploadId, parts } = req.body as {
      key?: string;
      uploadId?: string;
      parts?: Array<{ partNumber?: number; etag?: string }>;
    };
    const validParts = Array.isArray(parts) && parts.length > 0 && parts.every((part) =>
      Number.isInteger(part.partNumber) && part.partNumber! >= 1 && part.partNumber! <= 10_000 &&
      typeof part.etag === 'string' && part.etag.length > 0
    );
    if (!isSafeUploadKey(key) || !uploadId || !validParts) {
      res.status(400).json({ error: 'Invalid multipart completion payload.' });
      return;
    }
    await completeMultipartObjectUpload({
      key,
      uploadId,
      parts: parts!.map((part) => ({ partNumber: part.partNumber!, etag: part.etag! })),
    });
    res.json({ key });
  } catch (err) {
    console.error('[r2] Could not complete multipart upload:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Could not complete upload.' });
  }
});

app.post('/api/uploads/multipart/abort', async (req, res) => {
  try {
    const { key, uploadId } = req.body as { key?: string; uploadId?: string };
    if (!isSafeUploadKey(key) || !uploadId) {
      res.status(400).json({ error: 'Invalid multipart upload.' });
      return;
    }
    await abortMultipartObjectUpload({ key, uploadId });
    res.json({ ok: true });
  } catch (err) {
    console.error('[r2] Could not abort multipart upload:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Could not abort upload.' });
  }
});

app.post('/api/videos/from-storage', async (req, res) => {
  if (!isObjectStorageConfigured()) {
    res.status(501).json({ error: 'Object storage (S3/R2) is not configured.' });
    return;
  }

  let temporaryInputPath: string | undefined;
  try {
    const {
      key,
      originalName = 'uploaded-video.mp4',
      sizeBytes = 0,
      title,
      projectId = 1,
      useAi = false,
      editorOnly = false,
      requestedClipCount = DEFAULT_CLIP_COUNT,
      transcriptText = '',
    } = req.body as {
      key?: string;
      originalName?: string;
      sizeBytes?: number;
      title?: string;
      projectId?: number;
      useAi?: boolean;
      editorOnly?: boolean;
      requestedClipCount?: number;
      transcriptText?: string;
    };

    if (!key || !key.startsWith('uploads/') || key.includes('..')) {
      res.status(400).json({ error: 'Invalid object storage key.' });
      return;
    }

    temporaryInputPath = await downloadObjectStorageKeyToTemp({
      key,
      extension: path.extname(originalName || key) || '.mp4',
    });
    const localMeta = await analyzeVideo(temporaryInputPath);
    const probed = {
      meta: localMeta,
      sizeBytes: (await fs.promises.stat(temporaryInputPath)).size,
      originalName: path.basename(originalName || key),
    };
    const numericProjectId = Number(projectId) || 1;
    const aiEnabled = useAi === true;
    const clipCount = normalizeClipCount(requestedClipCount);
    const cleanTranscript = typeof transcriptText === 'string' ? transcriptText.trim() : '';
    const resolvedName = path.basename(originalName || probed.originalName);
    const resolvedTitle =
      (title ?? '').trim().slice(0, 120) ||
      resolvedName.replace(/\.[^.]+$/, '') ||
      'Uploaded Video';

    const { video, job } = await mutateDb((db) => {
      const videoId = db.nextIds.video++;
      const v = {
        id: videoId,
        projectId: numericProjectId,
        title: resolvedTitle,
        filename: path.basename(key),
        originalName: resolvedName,
        fileUrl: `/api/media/${key.split('/').map(encodeURIComponent).join('/')}`,
        sourceUrl: `r2://${key}`,
        storageKey: key,
        sourceType: 'url' as const,
        thumbnailUrl: null as string | null,
        duration: probed.meta.duration,
        width: probed.meta.width,
        height: probed.meta.height,
        fps: probed.meta.fps,
        hasAudio: probed.meta.hasAudio,
        sizeBytes: Number(sizeBytes) || probed.sizeBytes,
        status: 'processing' as const,
        createdAt: new Date().toISOString(),
      };
      db.videos.push(v);

      const jobId = db.nextIds.job++;
      const j = {
        id: jobId,
        projectId: numericProjectId,
        videoId,
        stage: 'queued' as const,
        progress: 10,
        message: 'Object storage video verified & queued (Audio-First + Fast Seek)...',
        useAi: aiEnabled,
        editorOnly: editorOnly === true,
        requestedClipCount: clipCount,
        updatedAt: new Date().toISOString(),
      };
      db.processingJobs.push(j);
      return { video: v, job: j };
    });

    const thumbUrl = await generateThumbnail(
      temporaryInputPath,
      `video-${video.id}-cover.jpg`,
      Math.min(2, Math.max(0.2, probed.meta.duration * 0.15))
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
      useAi: aiEnabled,
      editorOnly: editorOnly === true,
      requestedClipCount: clipCount,
      suppliedTranscript: cleanTranscript,
      temporaryInputPath,
    });
    temporaryInputPath = undefined;

    res.status(201).json({ video, job });
  } catch (err) {
    if (temporaryInputPath) safeUnlink(temporaryInputPath);
    const statusCode =
      err instanceof UrlIngestionError
        ? err.statusCode
        : (err as { statusCode?: number }).statusCode ?? 500;
    const message =
      err instanceof Error ? err.message : 'Failed to register uploaded object storage video';
    res.status(statusCode).json({ error: message });
  }
});

app.post('/api/videos/from-url', async (req, res) => {
  try {
    const {
      url,
      title,
      projectId = 1,
      useAi = false,
      editorOnly = false,
      requestedClipCount = DEFAULT_CLIP_COUNT,
      transcriptText = '',
    } = req.body as {
      url?: string;
      title?: string;
      projectId?: number;
      useAi?: boolean;
      editorOnly?: boolean;
      requestedClipCount?: number;
      transcriptText?: string;
    };

    if (!url || !url.trim()) {
      res.status(400).json({ error: 'Please provide a video URL or YouTube link.' });
      return;
    }

    const urlCheck = validateSafeHttpUrl(url);
    if (!urlCheck.valid || !urlCheck.url) {
      res.status(400).json({ error: urlCheck.error });
      return;
    }

    const cleanUrl = urlCheck.url.toString();
    const numericProjectId = Number(projectId) || 1;
    const aiEnabled = useAi === true;
    const clipCount = normalizeClipCount(requestedClipCount);
    const cleanTranscript = typeof transcriptText === 'string' ? transcriptText.trim() : '';

    if (isYouTubeUrl(cleanUrl)) {
      const yt = await processingQueue.run(() => ingestYouTubeUrl(cleanUrl));
      const result = await finalizeUploadedVideo({
        filePath: yt.filePath,
        filename: yt.filename,
        originalName: yt.originalName,
        sizeBytes: yt.sizeBytes,
        title: (title ?? '').trim().slice(0, 120) || yt.title,
        projectId: numericProjectId,
        useAi: aiEnabled,
        editorOnly: editorOnly === true,
        requestedClipCount: clipCount,
        transcriptText: cleanTranscript,
        presetSegments: !cleanTranscript && yt.segments.length > 0 ? yt.segments : undefined,
        transcriptSource: !cleanTranscript && yt.segments.length > 0 ? 'srt' : undefined,
      });

      // If YouTube provided native captions and user didn't override, persist them immediately
      if (!cleanTranscript && yt.segments.length > 0) {
        await mutateDb((db) => {
          db.transcriptions = db.transcriptions.filter((t) => t.videoId !== result.video.id);
          db.transcriptions.push({
            id: db.nextIds.transcription++,
            videoId: result.video.id,
            source: 'srt',
            language: 'auto',
            segments: yt.segments,
            createdAt: new Date().toISOString(),
          });
          const v = db.videos.find((item) => item.id === result.video.id);
          if (v) v.sourceType = 'youtube';
        });
      } else {
        await mutateDb((db) => {
          const v = db.videos.find((item) => item.id === result.video.id);
          if (v) v.sourceType = 'youtube';
        });
      }

      res.status(201).json(result);
      return;
    }

    // Direct remote video URL (MP4 / WebM / MOV / R2 / S3): Audio-First + HTTP Range Fast-Seek
    const probed = await probeRemoteDirectUrl(cleanUrl);
    const resolvedTitle =
      (title ?? '').trim().slice(0, 120) ||
      probed.originalName.replace(/\.[^.]+$/, '') ||
      'Remote Video';

    const { video, job } = await mutateDb((db) => {
      const videoId = db.nextIds.video++;
      const v = {
        id: videoId,
        projectId: numericProjectId,
        title: resolvedTitle,
        filename: probed.originalName,
        originalName: probed.originalName,
        fileUrl: cleanUrl,
        sourceUrl: cleanUrl,
        sourceType: 'url' as const,
        thumbnailUrl: null as string | null,
        duration: probed.meta.duration,
        width: probed.meta.width,
        height: probed.meta.height,
        fps: probed.meta.fps,
        hasAudio: probed.meta.hasAudio,
        sizeBytes: probed.sizeBytes,
        status: 'processing' as const,
        createdAt: new Date().toISOString(),
      };
      db.videos.push(v);

      const jobId = db.nextIds.job++;
      const j = {
        id: jobId,
        projectId: numericProjectId,
        videoId,
        stage: 'queued' as const,
        progress: 10,
        message: 'Remote video stream verified & queued (Audio-First + Fast Seek)...',
        useAi: aiEnabled,
        editorOnly: editorOnly === true,
        requestedClipCount: clipCount,
        updatedAt: new Date().toISOString(),
      };
      db.processingJobs.push(j);
      return { video: v, job: j };
    });

    const thumbUrl = await generateThumbnail(
      cleanUrl,
      `video-${video.id}-cover.jpg`,
      Math.min(2, Math.max(0.2, probed.meta.duration * 0.15))
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
      useAi: aiEnabled,
      editorOnly: editorOnly === true,
      requestedClipCount: clipCount,
      suppliedTranscript: cleanTranscript,
    });

    res.status(201).json({ video, job });
  } catch (err) {
    const statusCode =
      err instanceof UrlIngestionError
        ? err.statusCode
        : (err as { statusCode?: number }).statusCode ?? 500;
    const message = err instanceof Error ? err.message : 'Failed to import video from URL';
    const extra =
      err instanceof UrlIngestionError
        ? {
            detectedTitle: err.detectedTitle,
            youtubeBlocked: err.youtubeBlocked,
          }
        : {};
    res.status(statusCode).json({ error: message, ...extra });
  }
});

app.post('/api/videos/:id/retry', async (req, res) => {
  const videoId = Number(req.params.id);
  const useAi = req.body?.useAi === true;
  const requestedClipCount = normalizeClipCount(req.body?.requestedClipCount);
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
      requestedClipCount,
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
    requestedClipCount,
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
    requestedClipCount?: number;
  };
  const requestedClipCount = normalizeClipCount(req.body?.requestedClipCount);
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
      requestedClipCount,
      updatedAt: new Date().toISOString(),
    };
    state.processingJobs.push(j);
    return j;
  });

  void runVideoPipeline({
    videoId,
    jobId: job.id,
    useAi,
    requestedClipCount,
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

const execFileAsync = promisify(execFile);
const PREVIEWS_DIR = path.join(STORAGE_ROOT, 'previews');
const activePreviewJobs = new Map<string, Promise<void>>();

app.get('/api/videos/:id/preview', async (req, res) => {
  const videoId = Number(req.params.id);
  const format = req.query.format === 'webm' ? 'webm' : 'mp4';
  const db = readDb();
  const video = db.videos.find((v) => v.id === videoId);
  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  const videoPath = resolveVideoInputSource(video);
  if (!videoPath.startsWith('http') && !fs.existsSync(videoPath)) {
    res.status(404).json({ error: 'Source video file is missing on disk.' });
    return;
  }

  const rawStart = Number(req.query.start);
  const rawEnd = Number(req.query.end);
  const hasWindow = Number.isFinite(rawStart) || Number.isFinite(rawEnd);
  const totalDur = Math.max(1, video.duration || 60);
  const winStart = Number.isFinite(rawStart)
    ? Math.max(0, Math.min(totalDur - 1, Math.floor(rawStart)))
    : 0;
  // Cap any single transcode slice to 75 seconds so long videos respond in ~2-4s instead of timing out
  const maxSlice = 75;
  const targetEnd = Number.isFinite(rawEnd)
    ? Math.max(winStart + 2, Math.min(totalDur, Math.ceil(rawEnd)))
    : Math.min(totalDur, winStart + (totalDur > 90 ? 60 : totalDur));
  const winDur = Math.max(2, Math.min(maxSlice, targetEnd - winStart));

  fs.mkdirSync(PREVIEWS_DIR, { recursive: true });
  const cacheTag = hasWindow || totalDur > 90 ? `w${winStart}-${Math.round(winDur)}` : 'full';
  const outPath = path.join(PREVIEWS_DIR, `video-${video.id}-${cacheTag}-preview.${format}`);

  try {
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      let pending = activePreviewJobs.get(outPath);
      if (!pending) {
        const tmpPath = `${outPath}.tmp.${Date.now()}.${format}`;
        const seekArgs = hasWindow || totalDur > 90
          ? ['-ss', winStart.toFixed(2), '-t', winDur.toFixed(2)]
          : [];
        const buildPreviewArgs = (inputPath: string) =>
          format === 'webm'
            ? [
                '-y',
                ...seekArgs,
                '-i',
                inputPath,
                '-vf',
                'scale=-2:480',
                '-r',
                '30',
                '-c:v',
                'libvpx',
                '-deadline',
                'realtime',
                '-cpu-used',
                '8',
                '-b:v',
                '900k',
                ...(video.hasAudio ? ['-c:a', 'libopus', '-b:a', '96k'] : ['-an']),
                tmpPath,
              ]
            : [
                '-y',
                ...seekArgs,
                '-i',
                inputPath,
                '-vf',
                'scale=-2:480',
                '-r',
                '30',
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-crf',
                '26',
                '-pix_fmt',
                'yuv420p',
                '-movflags',
                '+faststart',
                ...(video.hasAudio ? ['-c:a', 'aac', '-b:a', '96k'] : ['-an']),
                tmpPath,
              ];

        pending = (async () => {
          try {
            await execFileAsync('ffmpeg', buildPreviewArgs(videoPath), {
              timeout: videoPath.startsWith('http') ? 120000 : 90000,
              maxBuffer: 16 * 1024 * 1024,
            });
          } catch (remoteError) {
            safeUnlink(tmpPath);
            if (!video.storageKey) throw remoteError;
            let localSource: string | undefined;
            try {
              localSource = await downloadObjectStorageKeyToTemp({
                key: video.storageKey,
                extension: path.extname(video.originalName || video.filename) || '.mp4',
              });
              await execFileAsync('ffmpeg', buildPreviewArgs(localSource), {
                timeout: 5 * 60 * 1000,
                maxBuffer: 16 * 1024 * 1024,
              });
            } finally {
              if (localSource) safeUnlink(localSource);
            }
          }
          fs.renameSync(tmpPath, outPath);
        })()
          .catch((err) => {
            safeUnlink(tmpPath);
            throw err;
          })
          .finally(() => {
            activePreviewJobs.delete(outPath);
          });
        activePreviewJobs.set(outPath, pending);
      }
      await pending;
    }

    res.sendFile(outPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Preview generation failed';
    res.status(500).json({ error: message });
  }
});

app.delete('/api/videos/:id', async (req, res) => {
  const videoId = Number(req.params.id);
  const storageBefore = getStorageUsageBytes();
  const db = readDb();
  const video = db.videos.find((v) => v.id === videoId);
  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  const videoClips = db.clips.filter((c) => c.videoId === videoId);
  const remoteKeys = new Set<string>();
  const cloudinaryKeys = new Set<string>([`clipforge/thumbnails/video-${videoId}-cover`]);
  const subtitleDocuments = new Set<string>();
  for (const key of [video.storageKey, objectKeyFromUrl(video.sourceUrl), objectKeyFromUrl(video.fileUrl), objectKeyFromUrl(video.thumbnailUrl)]) {
    if (key) remoteKeys.add(key);
  }
  for (const clip of videoClips) {
    cloudinaryKeys.add(`clipforge/thumbnails/clip-${clip.id}-preview`);
    for (const key of [clip.exportedKey, clip.srtKey, clip.thumbnailKey]) {
      if (!key) continue;
      if (key.startsWith('clipforge/')) cloudinaryKeys.add(key);
      else remoteKeys.add(key);
    }
    if (clip.subtitleDocumentId) subtitleDocuments.add(clip.subtitleDocumentId);
    subtitleDocuments.add(clipSubtitleDocumentId(clip.id, 'vertical'));
    subtitleDocuments.add(clipSubtitleDocumentId(clip.id, 'horizontal'));
    for (const url of [clip.exportedUrl, clip.srtUrl, clip.thumbnailUrl]) {
      const key = objectKeyFromUrl(url);
      if (key) remoteKeys.add(key);
    }
    for (const variant of Object.values(clip.exportVariants ?? {})) {
      for (const key of [variant?.exportedKey, variant?.srtKey, variant?.thumbnailKey]) {
        if (!key) continue;
        if (key.startsWith('clipforge/')) cloudinaryKeys.add(key);
        else remoteKeys.add(key);
      }
      if (variant?.subtitleDocumentId) subtitleDocuments.add(variant.subtitleDocumentId);
      for (const url of [variant?.exportedUrl, variant?.srtUrl, variant?.thumbnailUrl]) {
        const key = objectKeyFromUrl(url);
        if (key) remoteKeys.add(key);
      }
    }
  }
  const removedRemoteObjects = await deleteObjectStorageKeys(remoteKeys);
  const removedCloudinaryImages = await deleteCloudinaryKeys(cloudinaryKeys);
  let removedSubtitleDocuments = 0;
  for (const documentId of subtitleDocuments) {
    if (await deleteSubtitleText(documentId)) removedSubtitleDocuments++;
  }

  if (!video.sourceUrl) {
    safeUnlink(path.join(UPLOADS_DIR, path.basename(video.filename)));
  }
  if (fs.existsSync(PREVIEWS_DIR)) {
    for (const f of fs.readdirSync(PREVIEWS_DIR)) {
      if (f.startsWith(`video-${video.id}-`)) {
        safeUnlink(path.join(PREVIEWS_DIR, f));
      }
    }
  }
  for (const clip of videoClips) {
    if (clip.exportedUrl) safeUnlink(path.join(CLIPS_DIR, path.basename(clip.exportedUrl)));
    if (clip.srtUrl) safeUnlink(path.join(CLIPS_DIR, path.basename(clip.srtUrl)));
    for (const variant of Object.values(clip.exportVariants ?? {})) {
      if (variant?.exportedUrl) safeUnlink(path.join(CLIPS_DIR, path.basename(variant.exportedUrl)));
      if (variant?.srtUrl) safeUnlink(path.join(CLIPS_DIR, path.basename(variant.srtUrl)));
    }
  }

  await mutateDb((state) => {
    state.videos = state.videos.filter((v) => v.id !== videoId);
    state.transcriptions = state.transcriptions.filter((t) => t.videoId !== videoId);
    state.clips = state.clips.filter((c) => c.videoId !== videoId);
    state.processingJobs = state.processingJobs.filter((j) => j.videoId !== videoId);
  });

  let removedArtifacts = removeClipArtifactsByIds(videoClips.map((clip) => clip.id));
  removedArtifacts += reconcileOrphanedClipArtifacts();
  for (const filename of fs.readdirSync(THUMBNAILS_DIR)) {
    if (filename.startsWith(`video-${videoId}-`)) {
      safeUnlink(path.join(THUMBNAILS_DIR, filename));
      removedArtifacts++;
    }
  }
  for (const filename of fs.readdirSync(TRANSCRIPTS_DIR)) {
    if (filename.startsWith(`video-${videoId}-`)) {
      safeUnlink(path.join(TRANSCRIPTS_DIR, filename));
      removedArtifacts++;
    }
  }

  res.json({
    ok: true,
    removedArtifacts,
    removedRemoteObjects,
    removedCloudinaryImages,
    removedSubtitleDocuments,
    removedBytes: Math.max(0, storageBefore - getStorageUsageBytes()),
  });
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
  const videoPath = resolveVideoInputSource(video);
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
      compositions: ensureClipCompositions({}),
      exportVariants: {},
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
    if (Array.isArray(patch.timelineSegments)) {
      const video = db.videos.find((item) => item.id === clip.videoId);
      const maxDuration = Math.max(1, video?.duration ?? clip.endTime);
      const normalized = patch.timelineSegments
        .filter((segment) => segment && typeof segment.id === 'string' && Number.isFinite(segment.start) && Number.isFinite(segment.end))
        .map((segment) => ({
          id: segment.id.slice(0, 80),
          start: Math.max(0, Math.min(maxDuration, Math.round(segment.start * 1000) / 1000)),
          end: Math.max(0, Math.min(maxDuration, Math.round(segment.end * 1000) / 1000)),
        }))
        .filter((segment) => segment.end - segment.start >= 0.1)
        .slice(0, 100);
      if (normalized.length > 0) {
        clip.timelineSegments = normalized;
        clip.startTime = Math.min(...normalized.map((segment) => segment.start));
        clip.endTime = Math.max(...normalized.map((segment) => segment.end));
      }
    }
    if (patch.status) clip.status = patch.status;
    if (patch.aspectRatio) clip.aspectRatio = patch.aspectRatio;
    if (patch.framingMode) clip.framingMode = patch.framingMode;
    if (typeof patch.cropX === 'number') clip.cropX = Math.min(100, Math.max(0, patch.cropX));
    if (typeof patch.cropY === 'number') clip.cropY = Math.min(100, Math.max(0, patch.cropY));
    if (typeof patch.zoom === 'number') clip.zoom = Math.min(2, Math.max(1, patch.zoom));
    if (patch.compositions) {
      clip.compositions = {
        ...ensureClipCompositions(clip),
        ...patch.compositions,
      };
    }
    if (patch.compositionKeyframes && typeof patch.compositionKeyframes === 'object') {
      const totalDuration = (clip.timelineSegments?.length
        ? clip.timelineSegments.reduce((sum, segment) => sum + segment.end - segment.start, 0)
        : clip.endTime - clip.startTime);
      const next = { ...(clip.compositionKeyframes ?? {}) };
      for (const variant of ['vertical', 'horizontal'] as const) {
        const frames = patch.compositionKeyframes[variant];
        if (!Array.isArray(frames)) continue;
        next[variant] = frames
          .filter((frame) => frame && typeof frame.id === 'string' && Number.isFinite(frame.time) && frame.composition)
          .map((frame) => ({
            id: frame.id.slice(0, 80),
            time: Math.max(0, Math.min(totalDuration, Math.round(frame.time * 1000) / 1000)),
            composition: { ...ensureClipCompositions(clip)[variant], ...frame.composition },
          }))
          .sort((a, b) => a.time - b.time)
          .slice(0, 100);
      }
      clip.compositionKeyframes = next;
    }
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
    const variant: CompositionVariant = req.query.variant === 'horizontal' ? 'horizontal' : 'vertical';
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
    const videoPath = resolveVideoInputSource(video);
    const previousExport = clip.exportVariants?.[variant];

    // Serialize heavy FFmpeg rendering through the single-worker queue
    const rendered = await processingQueue.run(async () => {
      let temporarySource: string | undefined;
      try {
        if (video.storageKey) {
          temporarySource = await downloadObjectStorageKeyToTemp({
            key: video.storageKey,
            extension: path.extname(video.originalName || video.filename) || '.mp4',
          });
        }
        return await renderClipWithFfmpeg({
          clip,
          videoPath: temporarySource ?? videoPath,
          hasAudio: video.hasAudio,
          segments: trans?.segments ?? [],
          variant,
        });
      } finally {
        if (temporarySource) safeUnlink(temporarySource);
      }
    });

    const updated = await mutateDb((state) => {
      const target = state.clips.find((c) => c.id === clipId);
      if (!target) return null;
      target.exportedUrl = rendered.exportedUrl;
      target.srtUrl = rendered.srtUrl;
      target.exportedKey = rendered.exportedKey;
      target.srtKey = rendered.srtKey;
      target.thumbnailKey = rendered.thumbnailKey;
      target.subtitleDocumentId = rendered.subtitleDocumentId;
      target.exportedSizeBytes = rendered.exportedSizeBytes;
      if (rendered.thumbnailUrl) target.thumbnailUrl = rendered.thumbnailUrl;
      target.exportVariants = {
        ...(target.exportVariants ?? {}),
        [variant]: rendered,
      };
      target.aspectRatio = variant === 'vertical' ? '9:16' : '16:9';
      target.status = 'exported';
      return target;
    });

    const obsoleteKeys = new Set<string>();
    const obsoleteCloudinaryKeys = new Set<string>();
    for (const key of [previousExport?.exportedKey, previousExport?.srtKey, previousExport?.thumbnailKey]) {
      if (!key) continue;
      if (key.startsWith('clipforge/')) obsoleteCloudinaryKeys.add(key);
      else obsoleteKeys.add(key);
    }
    for (const url of [previousExport?.exportedUrl, previousExport?.srtUrl, previousExport?.thumbnailUrl]) {
      const key = objectKeyFromUrl(url);
      if (key) obsoleteKeys.add(key);
    }
    for (const key of [rendered.exportedKey, rendered.srtKey, rendered.thumbnailKey]) {
      if (!key) continue;
      obsoleteKeys.delete(key);
      obsoleteCloudinaryKeys.delete(key);
    }
    await deleteObjectStorageKeys(obsoleteKeys);
    await deleteCloudinaryKeys(obsoleteCloudinaryKeys);

    res.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'FFmpeg compilation failed';
    res.status(500).json({ error: message });
  }
});

app.get('/api/clips/:id/download', async (req, res) => {
  const clipId = Number(req.params.id);
  const format = req.query.format === 'srt' ? 'srt' : 'mp4';
  const db = readDb();
  const clip = db.clips.find((c) => c.id === clipId);
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }

  const variant: CompositionVariant = req.query.variant === 'horizontal' ? 'horizontal' : 'vertical';
  const variantExport = clip.exportVariants?.[variant];
  const subtitleDocumentId = variantExport?.subtitleDocumentId ?? clip.subtitleDocumentId;
  if (format === 'srt' && subtitleDocumentId && isFirestoreSubtitlesConfigured()) {
    const srt = await readSubtitleText(subtitleDocumentId);
    if (srt === null) {
      res.status(404).json({ error: 'Subtitle document is missing from Firestore.' });
      return;
    }
    const safeName = clip.title.replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase().slice(0, 48) || `clip-${clip.id}`;
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.srt"`);
    res.type('application/x-subrip; charset=utf-8').send(srt);
    return;
  }
  const targetUrl = format === 'srt'
    ? variantExport?.srtUrl ?? clip.srtUrl
    : variantExport?.exportedUrl ?? clip.exportedUrl;
  if (!targetUrl) {
    res.status(400).json({ error: 'Clip has not been compiled yet. Click Compile & Export first.' });
    return;
  }

  const remoteKey = format === 'srt'
    ? variantExport?.srtKey ?? clip.srtKey ?? objectKeyFromUrl(targetUrl)
    : variantExport?.exportedKey ?? clip.exportedKey ?? objectKeyFromUrl(targetUrl);
  if (remoteKey && isObjectStorageConfigured()) {
    res.redirect(307, buildReadableObjectUrl(remoteKey));
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
  const clip = readDb().clips.find((c) => c.id === clipId);
  const remoteKeys = new Set<string>();
  const cloudinaryKeys = new Set<string>();
  const subtitleDocuments = new Set<string>();
  if (clip) {
    for (const key of [clip.exportedKey, clip.srtKey, clip.thumbnailKey]) {
      if (!key) continue;
      if (key.startsWith('clipforge/')) cloudinaryKeys.add(key);
      else remoteKeys.add(key);
    }
    if (clip.subtitleDocumentId) subtitleDocuments.add(clip.subtitleDocumentId);
    for (const url of [clip.exportedUrl, clip.srtUrl, clip.thumbnailUrl]) {
      const key = objectKeyFromUrl(url);
      if (key) remoteKeys.add(key);
    }
    for (const variant of Object.values(clip.exportVariants ?? {})) {
      for (const key of [variant?.exportedKey, variant?.srtKey, variant?.thumbnailKey]) {
        if (!key) continue;
        if (key.startsWith('clipforge/')) cloudinaryKeys.add(key);
        else remoteKeys.add(key);
      }
      if (variant?.subtitleDocumentId) subtitleDocuments.add(variant.subtitleDocumentId);
      for (const url of [variant?.exportedUrl, variant?.srtUrl, variant?.thumbnailUrl]) {
        const key = objectKeyFromUrl(url);
        if (key) remoteKeys.add(key);
      }
    }
  }
  subtitleDocuments.add(clipSubtitleDocumentId(clipId, 'vertical'));
  subtitleDocuments.add(clipSubtitleDocumentId(clipId, 'horizontal'));
  cloudinaryKeys.add(`clipforge/thumbnails/clip-${clipId}-preview`);
  const removedRemoteObjects = await deleteObjectStorageKeys(remoteKeys);
  const removedCloudinaryImages = await deleteCloudinaryKeys(cloudinaryKeys);
  let removedSubtitleDocuments = 0;
  for (const documentId of subtitleDocuments) {
    if (await deleteSubtitleText(documentId)) removedSubtitleDocuments++;
  }
  if (clip?.exportedUrl) safeUnlink(path.join(CLIPS_DIR, path.basename(clip.exportedUrl)));
  if (clip?.srtUrl) safeUnlink(path.join(CLIPS_DIR, path.basename(clip.srtUrl)));
  for (const variant of Object.values(clip?.exportVariants ?? {})) {
    if (variant?.exportedUrl) safeUnlink(path.join(CLIPS_DIR, path.basename(variant.exportedUrl)));
    if (variant?.srtUrl) safeUnlink(path.join(CLIPS_DIR, path.basename(variant.srtUrl)));
  }
  await mutateDb((db) => {
    db.clips = db.clips.filter((c) => c.id !== clipId);
  });
  const removedArtifacts = removeClipArtifactsByIds([clipId]) + reconcileOrphanedClipArtifacts();
  res.json({ ok: true, removedArtifacts, removedRemoteObjects, removedCloudinaryImages, removedSubtitleDocuments });
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
  const queue = processingQueue.getStats();
  if (queue.active > 0 || queue.queued > 0) {
    res.status(409).json({
      error: 'Storage cannot be purged while videos or clips are being processed.',
    });
    return;
  }
  const report = purgeUnreferencedStorage();
  res.json({
    ok: true,
    removed: report.removedFiles,
    removedFiles: report.removedFiles,
    removedBytes: report.removedBytes,
    storageBytes: getStorageUsageBytes(),
  });
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
    // Serve a WebSocket-free Vite client shim because HMR is disabled in the iframe proxy
    app.get('/@vite/client', (_req, res) => {
      res.type('application/javascript').send(`
const sheetsMap = new Map();
export class ErrorOverlay extends HTMLElement {}
export function createHotContext() {
  return {
    data: {},
    accept() {},
    acceptExports() {},
    dispose() {},
    prune() {},
    decline() {},
    invalidate() {},
    on() {},
    off() {},
    send() {},
  };
}
export function injectQuery(url) { return url; }
export function updateStyle(id, content) {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    document.head.appendChild(style);
    sheetsMap.set(id, style);
  } else {
    style.textContent = content;
  }
}
export function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style) {
    document.head.removeChild(style);
    sheetsMap.delete(id);
  }
}
`);
    });
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, ws: false },
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
