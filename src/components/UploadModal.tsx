import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Cpu,
  FileText,
  Film,
  Link2,
  Loader2,
  Play,
  RotateCcw,
  Scissors,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { TRANSLATIONS, type Language } from '../i18n';
import type { ClipRecord, ProcessingJob, Project } from '../types';
import { formatBytes, formatTimecode } from '../utils/format';
import { ApiError, readJsonResponse } from '../utils/http';
import { apiUrl, mediaUrl } from '../utils/api';

interface UploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  projects: Project[];
  clips: ClipRecord[];
  geminiConfigured: boolean;
  maxUploadSizeBytes?: number;
  objectStorageConfigured?: boolean;
  onVideoCreated: (videoId: number, job: ProcessingJob) => void;
  onOpenStudio: (videoId: number, clipId?: number) => void;
  onRetryVideo: (videoId: number) => Promise<void>;
  activeJob: ProcessingJob | null;
  lang: Language;
}

interface UploadTelemetry {
  percent: number;
  loadedBytes: number;
  totalBytes: number;
  completedChunks: number;
  totalChunks: number;
  finalizing: boolean;
}

const SAMPLE_SRT_BY_LANG: Record<Language, string> = {
  en: `00:00:00,000 --> 00:00:06,000
Most creators think launching a clipping SaaS requires five autonomous AI agents.

00:00:06,000 --> 00:00:14,000
In reality, FFmpeg and a 100-point deterministic rubric solve 80% of the work for zero cost.`,
  es: `00:00:00,000 --> 00:00:06,000
Mucha gente piensa que lanzar un SaaS de clipping requiere cinco agentes de IA conversando.

00:00:06,000 --> 00:00:14,000
Pero realmente FFmpeg y una rúbrica determinista de 100 puntos resuelven el 80% a costo cero.`,
};

function uploadFileDirectWithProgress(
  putUrl: string,
  file: File,
  onProgress: (loadedBytes: number, totalBytes: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', putUrl, true);
    xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) {
        onProgress(ev.loaded, ev.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Object storage upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Network/CORS error uploading to object storage.'));
    xhr.send(file);
  });
}

async function uploadChunkWithRetry(
  uploadId: string,
  index: number,
  offset: number,
  slice: Blob,
  maxAttempts = 3
): Promise<void> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const chunkRes = await fetch(
        apiUrl(`/api/videos/upload/chunk/${uploadId}?index=${index}&offset=${offset}`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: slice,
        }
      );
      await readJsonResponse(chunkRes);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error('Chunk upload failed');
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 700 * attempt));
      }
    }
  }
  throw lastError ?? new Error('Chunk upload failed');
}

export const UploadModal: React.FC<UploadModalProps> = ({
  isOpen,
  onClose,
  projects,
  clips,
  geminiConfigured,
  maxUploadSizeBytes,
  objectStorageConfigured = false,
  onVideoCreated,
  onOpenStudio,
  onRetryVideo,
  activeJob,
  lang,
}) => {
  const t = TRANSLATIONS[lang].upload;
  const tc = TRANSLATIONS[lang].common;

  const effectiveMaxBytes =
    maxUploadSizeBytes && maxUploadSizeBytes > 0 ? maxUploadSizeBytes : 2048 * 1024 * 1024;
  const maxLimitLabel = formatBytes(effectiveMaxBytes);

  const bodyRef = useRef<HTMLDivElement>(null);

  const [sourceMode, setSourceMode] = useState<'file' | 'url'>('file');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState<number>(projects[0]?.id ?? 1);
  const [mode, setMode] = useState<'heuristic' | 'ai'>('heuristic');
  const [transcriptText, setTranscriptText] = useState('');
  const [srtFilename, setSrtFilename] = useState<string | null>(null);
  const [uploadStats, setUploadStats] = useState<UploadTelemetry | null>(null);
  const [uploadTarget, setUploadTarget] = useState<'chunks' | 'r2'>('chunks');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [youtubeFallback, setYoutubeFallback] = useState(false);

  const createdClips = useMemo(() => {
    if (!activeJob) return [];
    return clips.filter((c) => c.videoId === activeJob.videoId);
  }, [clips, activeJob]);

  useEffect(() => {
    if (uploadStats || activeJob || error) {
      bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [Boolean(uploadStats), activeJob?.stage, Boolean(error)]);

  if (!isOpen) return null;

  const isJobRunning =
    activeJob !== null &&
    activeJob.stage !== 'completed' &&
    activeJob.stage !== 'failed' &&
    activeJob.stage !== 'interrupted';

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    if (file && !title.trim()) {
      setTitle(file.name.replace(/\.[^.]+$/, ''));
    }
    setError(null);
    setYoutubeFallback(false);
  };

  const loadSrtFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.srt') || file.size > 2 * 1024 * 1024) {
      setError(t.errInvalidSrt);
      return;
    }
    const text = (await file.text()).replace(/^\uFEFF/, '');
    if (!text.includes('-->')) {
      setError(t.errInvalidSrt);
      return;
    }
    setTranscriptText(text.trim());
    setSrtFilename(file.name);
    setError(null);
  };

  const handleSrtFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await loadSrtFile(file);
  };

  const handleSwitchToFileFromYoutube = () => {
    setSourceMode('file');
    setError(null);
    setYoutubeFallback(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setYoutubeFallback(false);

    if (sourceMode === 'url') {
      const cleanUrl = remoteUrl.trim();
      if (!/^https?:\/\/.+/i.test(cleanUrl)) {
        setError(t.errNoUrl);
        return;
      }
      const looksLikeYt = /youtube\.com|youtu\.be/i.test(cleanUrl);
      if (mode === 'heuristic' && !transcriptText.trim() && !looksLikeYt) {
        setError(t.errNoTranscript);
        return;
      }

      setIsSubmitting(true);
      setError(null);
      try {
        const res = await fetch(apiUrl('/api/videos/from-url'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: cleanUrl,
            title: title.trim() || undefined,
            projectId,
            useAi: mode === 'ai',
            transcriptText: transcriptText.trim(),
          }),
        });
        const data = await readJsonResponse<{ video: { id: number }; job: ProcessingJob }>(res);
        onVideoCreated(data.video.id, data.job);
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.detectedTitle && !title.trim()) {
            setTitle(err.detectedTitle);
          }
          if (err.youtubeBlocked || err.statusCode === 422) {
            setYoutubeFallback(true);
          }
        }
        setError(err instanceof Error ? err.message : 'Failed to import URL');
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (!selectedFile) {
      setError(t.errNoFile);
      return;
    }
    if (selectedFile.size > effectiveMaxBytes) {
      setError(`${t.errTooLargePrefix} ${maxLimitLabel}.`);
      return;
    }
    if (mode === 'heuristic' && !transcriptText.trim()) {
      setError(t.errNoTranscript);
      return;
    }

    setIsSubmitting(true);
    setError(null);
    let uploadId: string | null = null;

    try {
      if (objectStorageConfigured) {
        setUploadTarget('r2');
        setUploadStats({
          percent: 0,
          loadedBytes: 0,
          totalBytes: selectedFile.size,
          completedChunks: 0,
          totalChunks: 1,
          finalizing: false,
        });

        const presignRes = await fetch(apiUrl('/api/uploads/presign'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: selectedFile.name,
            mimetype: selectedFile.type || 'video/mp4',
            sizeBytes: selectedFile.size,
          }),
        });
        const presign = await readJsonResponse<{ key: string; putUrl: string }>(presignRes);

        await uploadFileDirectWithProgress(presign.putUrl, selectedFile, (loaded, total) => {
          setUploadStats({
            percent: Math.min(99, Math.round((loaded / total) * 100)),
            loadedBytes: loaded,
            totalBytes: total,
            completedChunks: 0,
            totalChunks: 1,
            finalizing: false,
          });
        });

        setUploadStats({
          percent: 100,
          loadedBytes: selectedFile.size,
          totalBytes: selectedFile.size,
          completedChunks: 1,
          totalChunks: 1,
          finalizing: true,
        });

        const regRes = await fetch(apiUrl('/api/videos/from-storage'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key: presign.key,
            originalName: selectedFile.name,
            sizeBytes: selectedFile.size,
            title: title.trim() || selectedFile.name,
            projectId,
            useAi: mode === 'ai',
            transcriptText: transcriptText.trim(),
          }),
        });
        const data = await readJsonResponse<{ video: { id: number }; job: ProcessingJob }>(regRes);
        onVideoCreated(data.video.id, data.job);
        return;
      }

      setUploadTarget('chunks');
      const initRes = await fetch(apiUrl('/api/videos/upload/init'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: selectedFile.name,
          mimetype: selectedFile.type || 'video/mp4',
          sizeBytes: selectedFile.size,
          title: title.trim() || selectedFile.name,
          projectId,
          useAi: mode === 'ai',
          transcriptText: transcriptText.trim(),
        }),
      });
      const initData = await readJsonResponse<{
        uploadId: string;
        chunkSizeBytes: number;
        concurrency?: number;
      }>(initRes);
      uploadId = initData.uploadId;
      const chunkSize = initData.chunkSizeBytes || 5 * 1024 * 1024;
      const totalChunks = Math.ceil(selectedFile.size / chunkSize);
      const concurrency = Math.max(1, Math.min(4, initData.concurrency ?? 3));

      setUploadStats({
        percent: 0,
        loadedBytes: 0,
        totalBytes: selectedFile.size,
        completedChunks: 0,
        totalChunks,
        finalizing: false,
      });

      let nextIndex = 0;
      let completedChunks = 0;
      let loadedBytes = 0;

      const worker = async () => {
        while (true) {
          const index = nextIndex++;
          if (index >= totalChunks) return;
          const offset = index * chunkSize;
          const end = Math.min(selectedFile.size, offset + chunkSize);
          const slice = selectedFile.slice(offset, end);

          await uploadChunkWithRetry(uploadId!, index, offset, slice);
          completedChunks += 1;
          loadedBytes += slice.size;

          setUploadStats({
            percent: Math.min(99, Math.round((loadedBytes / selectedFile.size) * 100)),
            loadedBytes,
            totalBytes: selectedFile.size,
            completedChunks,
            totalChunks,
            finalizing: false,
          });
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(concurrency, totalChunks) }, () => worker())
      );

      setUploadStats({
        percent: 100,
        loadedBytes: selectedFile.size,
        totalBytes: selectedFile.size,
        completedChunks: totalChunks,
        totalChunks,
        finalizing: true,
      });

      const completeRes = await fetch(apiUrl(`/api/videos/upload/complete/${uploadId}`), {
        method: 'POST',
      });
      const data = await readJsonResponse<{ video: { id: number }; job: ProcessingJob }>(
        completeRes
      );
      onVideoCreated(data.video.id, data.job);
    } catch (err) {
      if (uploadId) {
        void fetch(apiUrl(`/api/videos/upload/${uploadId}`), { method: 'DELETE' });
      }
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsSubmitting(false);
      setUploadStats(null);
    }
  };

  const handleLoadDemo = async () => {
    setIsSubmitting(true);
    setError(null);
    setYoutubeFallback(false);
    try {
      const res = await fetch(apiUrl('/api/videos/demo'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          useAi: mode === 'ai' && geminiConfigured,
        }),
      });
      const data = await readJsonResponse<{ video: { id: number }; job: ProcessingJob }>(res);
      onVideoCreated(data.video.id, data.job);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load demo video');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRetry = async () => {
    if (!activeJob) return;
    setIsRetrying(true);
    try {
      await onRetryVideo(activeJob.videoId);
    } finally {
      setIsRetrying(false);
    }
  };

  const handleResetForNewUpload = () => {
    setSelectedFile(null);
    setRemoteUrl('');
    setTitle('');
    setTranscriptText('');
    setSrtFilename(null);
    setError(null);
    setYoutubeFallback(false);
  };

  const pinnedStatusText = uploadStats
    ? uploadStats.finalizing
      ? t.finalizingUpload
      : `${uploadTarget === 'r2' ? t.uploadingR2Progress : t.uploadingProgress}: ${uploadStats.percent}% (${formatBytes(uploadStats.loadedBytes)} / ${formatBytes(uploadStats.totalBytes)}${
          uploadStats.totalChunks > 1
            ? ` · ${uploadStats.completedChunks}/${uploadStats.totalChunks} ${t.chunksLabel}`
            : ''
        })`
    : isJobRunning && activeJob
    ? `${activeJob.message} (${activeJob.progress}%)`
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-white/10 dark:bg-[#111318]">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-white/10 shrink-0">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
              {t.title}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t.subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/5 dark:hover:text-white"
            aria-label={tc.close}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div ref={bodyRef} className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Live Upload Telemetry Card */}
          {uploadStats && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 space-y-2">
              <div className="flex items-center justify-between gap-3 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                  <span>
                    {uploadStats.finalizing
                      ? t.finalizingUpload
                      : uploadTarget === 'r2'
                      ? t.uploadingR2Progress
                      : t.uploadingProgress}
                  </span>
                </span>
                <span className="font-mono tabular-nums shrink-0">{uploadStats.percent}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-emerald-950/30">
                <div
                  className="h-full bg-emerald-500 transition-all duration-200"
                  style={{ width: `${uploadStats.percent}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-emerald-700/80 dark:text-emerald-200/80 font-mono tabular-nums">
                <span>
                  {formatBytes(uploadStats.loadedBytes)} / {formatBytes(uploadStats.totalBytes)}
                </span>
                {uploadStats.totalChunks > 1 && (
                  <span>
                    {uploadStats.completedChunks} / {uploadStats.totalChunks} {t.chunksLabel}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Live Pipeline Processing Card */}
          {isJobRunning && activeJob && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 space-y-2">
              <div className="flex items-center justify-between gap-3 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                  <span>{activeJob.message}</span>
                </span>
                <span className="font-mono tabular-nums shrink-0">{activeJob.progress}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-emerald-950/30">
                <div
                  className="h-full bg-emerald-500 transition-all duration-300"
                  style={{ width: `${activeJob.progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Completed Summary + Immediate Clip Preview List */}
          {activeJob && activeJob.stage === 'completed' && !uploadStats && (
            <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 space-y-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-2.5 text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-sm font-semibold">{t.clipsCreatedTitle}</div>
                    <div className="text-xs opacity-90">{activeJob.message}</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenStudio(activeJob.videoId, createdClips[0]?.id)}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400 whitespace-nowrap shrink-0"
                >
                  <Scissors className="h-3.5 w-3.5" />
                  <span>{t.openStudioPreview}</span>
                </button>
              </div>

              {createdClips.length === 0 ? (
                <p className="rounded-lg border border-emerald-500/20 bg-white/60 p-3 text-xs text-slate-700 dark:bg-black/25 dark:text-slate-300">
                  {t.noClipsCreated}
                </p>
              ) : (
                <div className="divide-y divide-emerald-500/20 rounded-lg border border-emerald-500/20 bg-white/80 dark:bg-[#151922]/90">
                  {createdClips.map((clip) => (
                    <div
                      key={clip.id}
                      className="flex items-center justify-between gap-3 p-3"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="h-12 w-20 shrink-0 overflow-hidden rounded bg-slate-900">
                          {clip.thumbnailUrl ? (
                            <img
                              src={mediaUrl(clip.thumbnailUrl)}
                              alt={clip.title}
                              referrerPolicy="no-referrer"
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center">
                              <Film className="h-4 w-4 text-slate-500" />
                            </div>
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-xs font-semibold text-slate-900 dark:text-white">
                            {clip.title}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                            <span>
                              {formatTimecode(clip.startTime)}–{formatTimecode(clip.endTime)}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                              {clip.score}/100
                            </span>
                            {clip.hookType && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-sans">{clip.hookType}</span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {clip.exportedUrl && (
                          <a
                            href={apiUrl(`/api/clips/${clip.id}/download?format=mp4`)}
                            className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-2.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 whitespace-nowrap"
                          >
                            <span>MP4</span>
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => onOpenStudio(activeJob.videoId, clip.id)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50 dark:border-white/10 dark:bg-white/5 dark:text-white dark:hover:bg-white/10 whitespace-nowrap"
                        >
                          <Play className="h-3 w-3 text-emerald-500" />
                          <span>{t.previewClipBtn}</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleResetForNewUpload}
                  className="text-xs font-medium text-slate-600 hover:text-slate-900 hover:underline dark:text-slate-300 dark:hover:text-white"
                >
                  {t.uploadAgainBtn}
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-white/15 dark:bg-white/5 dark:text-slate-200 dark:hover:bg-white/10"
                >
                  {t.viewProjectsBtn}
                </button>
              </div>
            </div>
          )}

          {/* Interrupted / Failed Job Recovery */}
          {activeJob && (activeJob.stage === 'failed' || activeJob.stage === 'interrupted') && (
            <div className="flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span className="text-xs">
                  {activeJob.stage === 'interrupted' ? t.interruptedWarning : activeJob.message}
                </span>
              </div>
              <button
                type="button"
                disabled={isRetrying}
                onClick={handleRetry}
                className="inline-flex items-center gap-1.5 rounded-md bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                {isRetrying ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" />
                )}
                <span>{t.retryProcessing}</span>
              </button>
            </div>
          )}

          {/* Demo Generator Box */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-white/10 dark:bg-white/[0.03]">
            <div>
              <p className="text-sm font-medium text-slate-900 dark:text-white">{t.demoTitle}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t.demoDesc}</p>
            </div>
            <button
              type="button"
              disabled={isSubmitting || isJobRunning}
              onClick={handleLoadDemo}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-900 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:border-white/15 dark:bg-white/5 dark:text-white dark:hover:bg-white/10 whitespace-nowrap shrink-0"
            >
              <Film className="h-4 w-4 text-emerald-500" />
              <span>{t.loadDemo}</span>
            </button>
          </div>

          <form id="clipforge-upload-form" onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-[#181B22]">
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => {
                  setSourceMode('file');
                  setError(null);
                  setYoutubeFallback(false);
                }}
                className={`inline-flex items-center justify-center gap-2 rounded-md py-1.5 text-xs font-medium transition-colors ${
                  sourceMode === 'file'
                    ? 'bg-white text-slate-900 shadow-sm dark:bg-[#252A36] dark:text-white'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                }`}
              >
                <Upload className="h-3.5 w-3.5" />
                <span>{t.sourceTabFile}</span>
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => {
                  setSourceMode('url');
                  setError(null);
                  setYoutubeFallback(false);
                }}
                className={`inline-flex items-center justify-center gap-2 rounded-md py-1.5 text-xs font-medium transition-colors ${
                  sourceMode === 'url'
                    ? 'bg-white text-slate-900 shadow-sm dark:bg-[#252A36] dark:text-white'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                }`}
              >
                <Link2 className="h-3.5 w-3.5" />
                <span>{t.sourceTabUrl}</span>
              </button>
            </div>

            {sourceMode === 'file' ? (
              <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50/70 px-6 py-7 text-center transition-colors hover:border-emerald-500/60 dark:border-white/15 dark:bg-white/[0.02]">
                <Upload className="mb-2 h-7 w-7 text-slate-400" />
                <span className="text-sm font-medium text-slate-900 dark:text-white">
                  {selectedFile ? selectedFile.name : t.dropzoneEmpty}
                </span>
                <span className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  {selectedFile
                    ? `${formatBytes(selectedFile.size)} · ${t.dropzoneReadySuffix}`
                    : `${
                        objectStorageConfigured ? t.dropzoneHintR2Prefix : t.dropzoneHintPrefix
                      } ${maxLimitLabel}`}
                </span>
                <input
                  type="file"
                  accept="video/*,.mkv,.m4v"
                  disabled={isSubmitting}
                  onChange={handleFileChange}
                  className="sr-only"
                />
              </label>
            ) : (
              <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4 dark:border-white/10 dark:bg-white/[0.02] space-y-2">
                <label className="flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-300">
                  <Link2 className="h-3.5 w-3.5 text-emerald-500" />
                  <span>{t.urlLabel}</span>
                </label>
                <input
                  type="url"
                  value={remoteUrl}
                  disabled={isSubmitting}
                  onChange={(e) => {
                    setRemoteUrl(e.target.value);
                    setError(null);
                    setYoutubeFallback(false);
                  }}
                  placeholder={t.urlPlaceholder}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-900 placeholder-slate-400 focus:border-emerald-500 focus:outline-none dark:border-white/10 dark:bg-[#181B22] dark:text-white"
                />
                <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                  {t.urlHint}
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  {t.videoTitle}
                </label>
                <input
                  type="text"
                  value={title}
                  disabled={isSubmitting}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t.videoTitlePlaceholder}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-emerald-500 focus:outline-none dark:border-white/10 dark:bg-[#181B22] dark:text-white"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  {t.project}
                </label>
                <select
                  value={projectId}
                  disabled={isSubmitting}
                  onChange={(e) => setProjectId(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-white/10 dark:bg-[#181B22] dark:text-white"
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                {t.pipelineMode}
              </label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => setMode('heuristic')}
                  className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                    mode === 'heuristic'
                      ? 'border-emerald-500 bg-emerald-500/10'
                      : 'border-slate-200 hover:border-slate-300 dark:border-white/10 dark:hover:border-white/20'
                  }`}
                >
                  <Cpu className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                  <div>
                    <div className="text-sm font-medium text-slate-900 dark:text-white">
                      {t.modeHeuristicTitle}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {t.modeHeuristicDesc}
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => setMode('ai')}
                  className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                    mode === 'ai'
                      ? 'border-emerald-500 bg-emerald-500/10'
                      : 'border-slate-200 hover:border-slate-300 dark:border-white/10 dark:hover:border-white/20'
                  }`}
                >
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                  <div>
                    <div className="text-sm font-medium text-slate-900 dark:text-white">
                      {t.modeAiTitle}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {geminiConfigured ? t.modeAiReady : t.modeAiNeedsKey}
                    </div>
                  </div>
                </button>
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                  <FileText className="h-3.5 w-3.5" />
                  <span>{mode === 'heuristic' ? t.transcriptRequired : t.transcriptOptional}</span>
                  {srtFilename && (
                    <span className="font-mono text-[11px] text-emerald-600 dark:text-emerald-400">
                      · {t.srtLoaded}: {srtFilename}
                    </span>
                  )}
                </label>
                <div className="flex items-center gap-3">
                  <label className="inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400">
                    <Upload className="h-3 w-3" />
                    <span>{t.importSrt}</span>
                    <input
                      type="file"
                      accept=".srt"
                      disabled={isSubmitting}
                      onChange={handleSrtFileChange}
                      className="sr-only"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => {
                      setTranscriptText(SAMPLE_SRT_BY_LANG[lang]);
                      setSrtFilename(null);
                    }}
                    className="text-xs font-medium text-slate-500 hover:text-slate-900 hover:underline dark:text-slate-400 dark:hover:text-white"
                  >
                    {t.insertExample}
                  </button>
                </div>
              </div>
              <textarea
                rows={4}
                disabled={isSubmitting}
                value={transcriptText}
                onChange={(e) => {
                  setTranscriptText(e.target.value);
                  if (srtFilename) setSrtFilename(null);
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={async (e) => {
                  const file = e.dataTransfer.files?.[0];
                  if (file && file.name.toLowerCase().endsWith('.srt')) {
                    e.preventDefault();
                    await loadSrtFile(file);
                  }
                }}
                placeholder={t.transcriptPlaceholder}
                className="w-full rounded-lg border border-slate-200 bg-white p-3 font-mono text-xs text-slate-900 placeholder-slate-400 focus:border-emerald-500 focus:outline-none dark:border-white/10 dark:bg-[#181B22] dark:text-slate-100"
              />
            </div>

            {error && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300 space-y-2.5">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span className="leading-relaxed">{error}</span>
                </div>
                {youtubeFallback && (
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-red-500/20 pt-2.5">
                    <span className="text-[11px] text-slate-600 dark:text-slate-300">
                      {t.ytFallbackHint}
                    </span>
                    <button
                      type="button"
                      onClick={handleSwitchToFileFromYoutube}
                      className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 whitespace-nowrap shrink-0"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      <span>{t.ytSwitchToFile}</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </form>
        </div>

        {/* Always-Visible Pinned Status & Action Footer */}
        <div className="border-t border-slate-200 bg-slate-50/90 px-6 py-3.5 dark:border-white/10 dark:bg-[#0E1015] shrink-0 space-y-2.5">
          {pinnedStatusText && (
            <div className="flex items-center gap-2 text-xs font-medium text-emerald-700 dark:text-emerald-300 font-mono tabular-nums">
              <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
              <span className="truncate">{pinnedStatusText}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/5"
            >
              {activeJob?.stage === 'completed' ? tc.close : tc.cancel}
            </button>

            {activeJob?.stage === 'completed' && !uploadStats ? (
              <button
                type="button"
                onClick={() => onOpenStudio(activeJob.videoId, createdClips[0]?.id)}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2 text-sm font-semibold text-slate-950 transition-colors hover:bg-emerald-400"
              >
                <Scissors className="h-4 w-4" />
                <span>{t.openStudioPreview}</span>
              </button>
            ) : (
              <button
                type="submit"
                form="clipforge-upload-form"
                disabled={isSubmitting || isJobRunning}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2 text-sm font-semibold text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-60"
              >
                {(isSubmitting || isJobRunning) && <Loader2 className="h-4 w-4 animate-spin" />}
                <span className="tabular-nums">
                  {uploadStats
                    ? uploadStats.finalizing
                      ? t.finalizingUpload
                      : `${t.uploadingBtnLabel} ${uploadStats.percent}%`
                    : isJobRunning && activeJob
                    ? `${t.processingBtnLabel} ${activeJob.progress}%`
                    : isSubmitting && sourceMode === 'url'
                    ? t.inspectingUrl
                    : t.startPipeline}
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
