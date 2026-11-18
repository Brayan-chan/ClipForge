import React, { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Cpu,
  FileText,
  Film,
  Loader2,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { TRANSLATIONS, type Language } from '../i18n';
import type { ProcessingJob, Project } from '../types';

interface UploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  projects: Project[];
  geminiConfigured: boolean;
  onVideoCreated: (videoId: number, job: ProcessingJob) => void;
  activeJob: ProcessingJob | null;
  lang: Language;
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

export const UploadModal: React.FC<UploadModalProps> = ({
  isOpen,
  onClose,
  projects,
  geminiConfigured,
  onVideoCreated,
  activeJob,
  lang,
}) => {
  const t = TRANSLATIONS[lang].upload;
  const tc = TRANSLATIONS[lang].common;

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState<number>(projects[0]?.id ?? 1);
  const [mode, setMode] = useState<'heuristic' | 'ai'>('heuristic');
  const [transcriptText, setTranscriptText] = useState('');
  const [srtFilename, setSrtFilename] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    if (file && !title) {
      setTitle(file.name.replace(/\.[^.]+$/, ''));
    }
    setError(null);
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) {
      setError(t.errNoFile);
      return;
    }
    if (mode === 'heuristic' && !transcriptText.trim()) {
      setError(t.errNoTranscript);
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('video', selectedFile);
      form.append('title', title.trim() || selectedFile.name);
      form.append('projectId', String(projectId));
      form.append('useAi', String(mode === 'ai'));
      if (transcriptText.trim()) {
        form.append('transcriptText', transcriptText.trim());
      }

      const res = await fetch('/api/videos/upload', {
        method: 'POST',
        body: form,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Upload failed');
      }
      onVideoCreated(data.video.id, data.job);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLoadDemo = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/videos/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          useAi: mode === 'ai' && geminiConfigured,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to generate demo video');
      }
      onVideoCreated(data.video.id, data.job);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load demo video');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-white/10 dark:bg-[#111318]">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-white/10">
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

        <div className="max-h-[82vh] overflow-y-auto p-6 space-y-5">
          {activeJob && activeJob.stage !== 'completed' && activeJob.stage !== 'failed' && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
              <div className="flex items-center justify-between text-sm font-medium text-emerald-700 dark:text-emerald-300">
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{activeJob.message}</span>
                </span>
                <span className="font-mono tabular-nums">{activeJob.progress}%</span>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-emerald-950/30">
                <div
                  className="h-full bg-emerald-500 transition-all duration-300"
                  style={{ width: `${activeJob.progress}%` }}
                />
              </div>
            </div>
          )}

          {activeJob && activeJob.stage === 'completed' && (
            <div className="flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-700 dark:text-emerald-300">
              <span className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>{activeJob.message}</span>
              </span>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 whitespace-nowrap shrink-0"
              >
                {t.viewClipsBtn}
              </button>
            </div>
          )}

          {activeJob && activeJob.stage === 'failed' && (
            <div className="flex items-start gap-2.5 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-600 dark:text-red-300">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{activeJob.message}</span>
            </div>
          )}

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-white/10 dark:bg-white/[0.03]">
            <div>
              <p className="text-sm font-medium text-slate-900 dark:text-white">{t.demoTitle}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t.demoDesc}</p>
            </div>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={handleLoadDemo}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-900 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:border-white/15 dark:bg-white/5 dark:text-white dark:hover:bg-white/10 whitespace-nowrap shrink-0"
            >
              <Film className="h-4 w-4 text-emerald-500" />
              <span>{t.loadDemo}</span>
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50/70 px-6 py-7 text-center transition-colors hover:border-emerald-500/60 dark:border-white/15 dark:bg-white/[0.02]">
              <Upload className="mb-2 h-7 w-7 text-slate-400" />
              <span className="text-sm font-medium text-slate-900 dark:text-white">
                {selectedFile ? selectedFile.name : t.dropzoneEmpty}
              </span>
              <span className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {selectedFile
                  ? `${(selectedFile.size / (1024 * 1024)).toFixed(1)} ${t.dropzoneReady}`
                  : t.dropzoneHint}
              </span>
              <input
                type="file"
                accept="video/*"
                onChange={handleFileChange}
                className="sr-only"
              />
            </label>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  {t.videoTitle}
                </label>
                <input
                  type="text"
                  value={title}
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
                      onChange={handleSrtFileChange}
                      className="sr-only"
                    />
                  </label>
                  <button
                    type="button"
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
              <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/5"
              >
                {tc.cancel}
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2 text-sm font-semibold text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-50"
              >
                {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
                <span>{t.startPipeline}</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
