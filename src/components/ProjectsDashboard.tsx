import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Film,
  FolderPlus,
  Loader2,
  Play,
  Scissors,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { TRANSLATIONS, type Language } from '../i18n';
import type { ClipRecord, ProcessingJob, Project, VideoRecord } from '../types';
import { formatBytes, formatShortDate, formatTimecode } from '../utils/format';
import { LanguageSwitch } from './LanguageSwitch';

interface ProjectsDashboardProps {
  projects: Project[];
  videos: VideoRecord[];
  clips: ClipRecord[];
  jobs: ProcessingJob[];
  onOpenUpload: () => void;
  onGenerateDemo: () => Promise<void>;
  onOpenStudio: (videoId: number, clipId?: number) => void;
  onDeleteVideo: (videoId: number) => Promise<void>;
  onCompileClip: (clipId: number) => Promise<void>;
  onCreateProject: (name: string) => Promise<void>;
  lang: Language;
  onChangeLang: (lang: Language) => void;
}

export const ProjectsDashboard: React.FC<ProjectsDashboardProps> = ({
  projects,
  videos,
  clips,
  jobs,
  onOpenUpload,
  onGenerateDemo,
  onOpenStudio,
  onDeleteVideo,
  onCompileClip,
  onCreateProject,
  lang,
  onChangeLang,
}) => {
  const t = TRANSLATIONS[lang].dashboard;
  const tc = TRANSLATIONS[lang].common;

  const [selectedProjectId, setSelectedProjectId] = useState<number | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'ready' | 'processing'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [detailVideoId, setDetailVideoId] = useState<number | null>(null);
  const [isDemoLoading, setIsDemoLoading] = useState(false);
  const [compilingClipId, setCompilingClipId] = useState<number | null>(null);
  const [newProjectName, setNewProjectName] = useState('');
  const [showNewProject, setShowNewProject] = useState(false);

  const filteredVideos = useMemo(() => {
    return videos.filter((v) => {
      if (selectedProjectId !== 'all' && v.projectId !== selectedProjectId) return false;
      if (statusFilter === 'ready' && v.status !== 'ready') return false;
      if (statusFilter === 'processing' && v.status !== 'processing') return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        if (!v.title.toLowerCase().includes(q) && !v.originalName.toLowerCase().includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [videos, selectedProjectId, statusFilter, searchQuery]);

  const stats = useMemo(() => {
    const exportedCount = clips.filter((c) => Boolean(c.exportedUrl)).length;
    const avgScore =
      clips.length > 0
        ? Math.round(clips.reduce((sum, c) => sum + c.score, 0) / clips.length)
        : 0;
    return {
      totalVideos: videos.length,
      totalClips: clips.length,
      exportedCount,
      avgScore,
    };
  }, [videos, clips]);

  const detailVideo = useMemo(
    () => videos.find((v) => v.id === detailVideoId) ?? null,
    [videos, detailVideoId]
  );

  const detailClips = useMemo(
    () => (detailVideo ? clips.filter((c) => c.videoId === detailVideo.id) : []),
    [clips, detailVideo]
  );

  const handleDemoClick = async () => {
    setIsDemoLoading(true);
    try {
      await onGenerateDemo();
    } finally {
      setIsDemoLoading(false);
    }
  };

  const handleCompile = async (clipId: number) => {
    setCompilingClipId(clipId);
    try {
      await onCompileClip(clipId);
    } finally {
      setCompilingClipId(null);
    }
  };

  const handleAddProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectName.trim()) return;
    await onCreateProject(newProjectName.trim());
    setNewProjectName('');
    setShowNewProject(false);
  };

  return (
    <main className="mx-auto max-w-[1440px] px-6 py-8 space-y-8">
      {/* Studio Workspace Header */}
      <section className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-2xl space-y-2">
          <h1 className="font-display text-3xl font-bold tracking-tight text-slate-900 dark:text-white [text-wrap:balance]">
            {t.headline}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">{t.subheadline}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <LanguageSwitch lang={lang} onChangeLang={onChangeLang} />

          <button
            type="button"
            disabled={isDemoLoading}
            onClick={handleDemoClick}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-white/15 dark:bg-[#111318] dark:text-slate-100 dark:hover:bg-white/5 whitespace-nowrap shrink-0"
          >
            {isDemoLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-emerald-500" />
            ) : (
              <Film className="h-4 w-4 text-emerald-500" />
            )}
            <span>{t.loadDemo}</span>
          </button>

          <button
            type="button"
            onClick={onOpenUpload}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition-colors hover:bg-emerald-400 whitespace-nowrap shrink-0"
          >
            <Upload className="h-4 w-4" />
            <span>{t.uploadVideo}</span>
          </button>
        </div>
      </section>

      {/* Hairline-separated KPI Strip */}
      <section className="grid grid-cols-2 divide-x divide-slate-200 border-y border-slate-200 py-4 dark:divide-white/10 dark:border-white/10 sm:grid-cols-4">
        <div className="px-4 first:pl-0">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">{t.kpiVideos}</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-slate-900 dark:text-white tabular-nums">
            {stats.totalVideos}
          </div>
        </div>
        <div className="px-4">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">{t.kpiClips}</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-slate-900 dark:text-white tabular-nums">
            {stats.totalClips}
          </div>
        </div>
        <div className="px-4">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">{t.kpiExported}</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
            {stats.exportedCount}
          </div>
        </div>
        <div className="px-4 last:pr-0">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">{t.kpiAvgScore}</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-slate-900 dark:text-white tabular-nums">
            {stats.avgScore}/100
          </div>
        </div>
      </section>

      {/* Filter Toolbar */}
      <section className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-[#111318]">
            {(['all', 'ready', 'processing'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setStatusFilter(tab)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  statusFilter === tab
                    ? 'bg-white text-slate-900 shadow-sm dark:bg-[#1E222B] dark:text-white'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                }`}
              >
                {tab === 'all' ? t.allVideos : tab === 'ready' ? t.ready : t.processing}
              </button>
            ))}
          </div>

          <select
            value={selectedProjectId}
            onChange={(e) =>
              setSelectedProjectId(e.target.value === 'all' ? 'all' : Number(e.target.value))
            }
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 focus:border-emerald-500 focus:outline-none dark:border-white/10 dark:bg-[#111318] dark:text-slate-200"
          >
            <option value="all">{t.allProjects}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => setShowNewProject((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/5 whitespace-nowrap shrink-0"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            <span>{t.newProject}</span>
          </button>
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t.searchPlaceholder}
            className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-9 pr-3 text-sm text-slate-900 placeholder-slate-400 focus:border-emerald-500 focus:outline-none dark:border-white/10 dark:bg-[#111318] dark:text-white"
          />
        </div>
      </section>

      {showNewProject && (
        <form
          onSubmit={handleAddProject}
          className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-[#111318]"
        >
          <input
            type="text"
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            placeholder={t.projectPlaceholder}
            className="flex-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-white/10 dark:bg-[#181B22] dark:text-white"
          />
          <button
            type="submit"
            className="rounded-md bg-emerald-500 px-4 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400"
          >
            {tc.create}
          </button>
          <button
            type="button"
            onClick={() => setShowNewProject(false)}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400"
          >
            {tc.cancel}
          </button>
        </form>
      )}

      {/* Video Grid or Empty State */}
      {filteredVideos.length === 0 ? (
        <section className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center dark:border-white/15 dark:bg-[#111318]">
          <Scissors className="mb-3 h-10 w-10 text-emerald-500" />
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
            {t.emptyTitle}
          </h2>
          <p className="mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">{t.emptyDesc}</p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              disabled={isDemoLoading}
              onClick={handleDemoClick}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50 dark:border-white/15 dark:bg-white/5 dark:text-white dark:hover:bg-white/10"
            >
              {isDemoLoading ? (
                <Loader2 className="h-4 w-4 animate-spin text-emerald-500" />
              ) : (
                <Film className="h-4 w-4 text-emerald-500" />
              )}
              <span>{t.loadDemo}</span>
            </button>
            <button
              type="button"
              onClick={onOpenUpload}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
            >
              <Upload className="h-4 w-4" />
              <span>{t.uploadFirst}</span>
            </button>
          </div>
        </section>
      ) : (
        <section className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {filteredVideos.map((video) => {
            const videoClips = clips.filter((c) => c.videoId === video.id);
            const latestJob = jobs.filter((j) => j.videoId === video.id).slice(-1)[0];

            return (
              <article
                key={video.id}
                className="group flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white transition-colors hover:border-slate-300 dark:border-white/10 dark:bg-[#111318] dark:hover:border-white/20"
              >
                <div className="relative aspect-video w-full overflow-hidden bg-slate-900">
                  {video.thumbnailUrl ? (
                    <img
                      src={video.thumbnailUrl}
                      alt={video.title}
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-slate-800 to-slate-950">
                      <Film className="h-10 w-10 text-slate-600" />
                    </div>
                  )}
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/75 to-transparent" />
                  <div className="absolute bottom-2.5 right-3 font-mono text-xs font-medium text-white tabular-nums">
                    {formatTimecode(video.duration)}
                  </div>
                </div>

                <div className="flex flex-1 flex-col justify-between p-4 space-y-4">
                  <div className="space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="font-display text-base font-semibold text-slate-900 dark:text-white line-clamp-1">
                        {video.title}
                      </h3>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                      <span>
                        {video.width}×{video.height}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{video.fps} fps</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {videoClips.length} {t.clipsLabel}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{formatShortDate(video.createdAt, lang)}</span>
                    </div>

                    <div className="pt-1">
                      {video.status === 'ready' && (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>{t.readyStatus}</span>
                        </span>
                      )}
                      {video.status === 'processing' && (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          <span>
                            {latestJob ? `${latestJob.message} (${latestJob.progress}%)` : t.processingStatus}
                          </span>
                        </span>
                      )}
                      {video.status === 'error' && (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
                          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                          <span className="line-clamp-1">{video.errorMessage || t.errorStatus}</span>
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-3 dark:border-white/5">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onOpenStudio(video.id, videoClips[0]?.id)}
                        disabled={video.status === 'processing'}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-40 whitespace-nowrap shrink-0"
                      >
                        <Scissors className="h-3.5 w-3.5" />
                        <span>{t.openStudio}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setDetailVideoId(video.id)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:text-slate-200 dark:hover:bg-white/5 whitespace-nowrap shrink-0"
                      >
                        <Play className="h-3.5 w-3.5" />
                        <span>{t.viewClips}</span>
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => onDeleteVideo(video.id)}
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-red-500/10 hover:text-red-500"
                      aria-label={`${tc.delete} ${video.title}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {/* Video Details & Generated Clips Modal */}
      {detailVideo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-4xl rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-white/10 dark:bg-[#111318]">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-white/10">
              <div className="flex items-center gap-2.5">
                <Film className="h-5 w-5 text-emerald-500" />
                <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
                  {detailVideo.title}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setDetailVideoId(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/5 dark:hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="max-h-[82vh] overflow-y-auto p-6 space-y-6">
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2 border-b border-slate-200 pb-6 dark:border-white/10">
                <div className="space-y-2 text-sm">
                  <h3 className="font-display text-xs font-semibold text-slate-500 dark:text-slate-400">
                    {t.modalMetadata}
                  </h3>
                  <div className="grid grid-cols-2 gap-y-1.5 text-xs">
                    <span className="text-slate-500 dark:text-slate-400">{t.modalFilename}</span>
                    <span className="font-mono text-slate-900 dark:text-white truncate">
                      {detailVideo.originalName}
                    </span>
                    <span className="text-slate-500 dark:text-slate-400">{t.modalResFps}</span>
                    <span className="font-mono text-slate-900 dark:text-white tabular-nums">
                      {detailVideo.width}×{detailVideo.height} · {detailVideo.fps} fps
                    </span>
                    <span className="text-slate-500 dark:text-slate-400">{t.modalDuration}</span>
                    <span className="font-mono text-slate-900 dark:text-white tabular-nums">
                      {formatTimecode(detailVideo.duration)}
                    </span>
                    <span className="text-slate-500 dark:text-slate-400">{t.modalSize}</span>
                    <span className="font-mono text-slate-900 dark:text-white tabular-nums">
                      {formatBytes(detailVideo.sizeBytes)}
                    </span>
                  </div>
                </div>

                <div className="flex flex-col justify-between gap-3">
                  <h3 className="font-display text-xs font-semibold text-slate-500 dark:text-slate-400">
                    {t.modalActions}
                  </h3>
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setDetailVideoId(null);
                        onOpenStudio(detailVideo.id, detailClips[0]?.id);
                      }}
                      className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
                    >
                      <Scissors className="h-4 w-4" />
                      <span>{t.modalOpenStudio}</span>
                    </button>
                    <a
                      href={detailVideo.fileUrl}
                      download={detailVideo.originalName}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:text-slate-200 dark:hover:bg-white/5"
                    >
                      <Download className="h-4 w-4" />
                      <span>{t.modalDownloadOrig}</span>
                    </a>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-white">
                    {t.modalGeneratedClips} ({detailClips.length})
                  </h3>
                </div>

                {detailClips.length === 0 ? (
                  <p className="text-sm text-slate-500 dark:text-slate-400">{t.modalNoClips}</p>
                ) : (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {detailClips.map((clip) => (
                      <div
                        key={clip.id}
                        className="flex flex-col justify-between rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-white/10 dark:bg-[#181B22]"
                      >
                        <div className="space-y-2">
                          <div className="relative aspect-video overflow-hidden rounded-md bg-slate-900">
                            {clip.thumbnailUrl ? (
                              <img
                                src={clip.thumbnailUrl}
                                alt={clip.title}
                                referrerPolicy="no-referrer"
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <div className="flex h-full items-center justify-center">
                                <Film className="h-6 w-6 text-slate-600" />
                              </div>
                            )}
                            <span className="absolute bottom-1.5 right-2 font-mono text-[11px] font-medium text-white bg-black/70 px-1.5 py-0.5 rounded tabular-nums">
                              {formatTimecode(clip.endTime - clip.startTime)}
                            </span>
                          </div>
                          <h4 className="text-sm font-semibold text-slate-900 dark:text-white line-clamp-2">
                            {clip.title}
                          </h4>
                          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                            <span>
                              {formatTimecode(clip.startTime)}–{formatTimecode(clip.endTime)}
                            </span>
                            <span>·</span>
                            <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                              {clip.score}/100
                            </span>
                            <span>·</span>
                            <span>{clip.aspectRatio}</span>
                          </div>
                        </div>

                        <div className="mt-3 flex items-center gap-2 pt-2 border-t border-slate-200 dark:border-white/10">
                          <button
                            type="button"
                            onClick={() => {
                              setDetailVideoId(null);
                              onOpenStudio(detailVideo.id, clip.id);
                            }}
                            className="flex-1 rounded-md border border-slate-200 bg-white py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-100 dark:border-white/10 dark:bg-white/5 dark:text-white dark:hover:bg-white/10"
                          >
                            {tc.edit}
                          </button>

                          {clip.exportedUrl ? (
                            <a
                              href={`/api/clips/${clip.id}/download?format=mp4`}
                              className="flex-1 inline-flex items-center justify-center gap-1 rounded-md bg-emerald-500 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400"
                            >
                              <Download className="h-3.5 w-3.5" />
                              <span>MP4</span>
                            </a>
                          ) : (
                            <button
                              type="button"
                              disabled={compilingClipId === clip.id}
                              onClick={() => handleCompile(clip.id)}
                              className="flex-1 inline-flex items-center justify-center gap-1 rounded-md bg-emerald-500 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
                            >
                              {compilingClipId === clip.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <span>{t.compile}</span>
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
};
