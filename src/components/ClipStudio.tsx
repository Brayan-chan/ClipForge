import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Download,
  Film,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Scissors,
  Sparkles,
  Subtitles,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { TRANSLATIONS, type Language } from '../i18n';
import type {
  AspectRatio,
  ClipRecord,
  FramingMode,
  ScoringConfig,
  SubtitleStyle,
  TranscriptSegment,
  TranscriptionRecord,
  VideoRecord,
} from '../types';
import { formatBytes, formatTimecode } from '../utils/format';
import { LanguageSwitch } from './LanguageSwitch';

interface ClipStudioProps {
  videos: VideoRecord[];
  clips: ClipRecord[];
  transcriptions: TranscriptionRecord[];
  scoringConfig: ScoringConfig;
  geminiConfigured: boolean;
  selectedVideoId: number | null;
  selectedClipId: number | null;
  onSelectVideo: (videoId: number) => void;
  onSelectClip: (clipId: number) => void;
  onUpdateClip: (clipId: number, patch: Partial<ClipRecord>) => Promise<ClipRecord>;
  onCompileClip: (clipId: number) => Promise<ClipRecord>;
  onRescoreClip: (clipId: number, useAi: boolean) => Promise<ClipRecord>;
  onCreateClip: (videoId: number, startTime: number, endTime: number) => Promise<ClipRecord>;
  onDeleteClip: (clipId: number) => Promise<void>;
  onSaveTranscript: (videoId: number, segments: TranscriptSegment[]) => Promise<void>;
  onOpenUpload: () => void;
  lang: Language;
  onChangeLang: (lang: Language) => void;
}

export const ClipStudio: React.FC<ClipStudioProps> = ({
  videos,
  clips,
  transcriptions,
  scoringConfig,
  geminiConfigured,
  selectedVideoId,
  selectedClipId,
  onSelectVideo,
  onSelectClip,
  onUpdateClip,
  onCompileClip,
  onRescoreClip,
  onCreateClip,
  onDeleteClip,
  onSaveTranscript,
  onOpenUpload,
  lang,
  onChangeLang,
}) => {
  const t = TRANSLATIONS[lang].studio;
  const tc = TRANSLATIONS[lang].common;
  const tn = TRANSLATIONS[lang].nav;

  const subtitlePresets: Array<{
    id: SubtitleStyle['preset'];
    label: string;
    style: Partial<SubtitleStyle>;
  }> = [
    {
      id: 'hormozi',
      label: t.presetHormozi,
      style: {
        preset: 'hormozi',
        fontSize: 24,
        textColor: '#FFFFFF',
        highlightColor: '#22C55E',
        position: 'bottom',
        alignment: 'center',
        backgroundBox: true,
      },
    },
    {
      id: 'clean',
      label: t.presetClean,
      style: {
        preset: 'clean',
        fontSize: 20,
        textColor: '#F8FAFC',
        highlightColor: '#38BDF8',
        position: 'bottom',
        alignment: 'center',
        backgroundBox: false,
      },
    },
    {
      id: 'boxed',
      label: t.presetBoxed,
      style: {
        preset: 'boxed',
        fontSize: 21,
        textColor: '#FDE047',
        highlightColor: '#FFFFFF',
        position: 'center',
        alignment: 'center',
        backgroundBox: true,
      },
    },
    {
      id: 'minimal',
      label: t.presetMinimal,
      style: {
        preset: 'minimal',
        fontSize: 18,
        textColor: '#E2E8F0',
        highlightColor: '#22C55E',
        position: 'top',
        alignment: 'left',
        backgroundBox: false,
      },
    },
  ];

  const activeVideo = useMemo(
    () => videos.find((v) => v.id === selectedVideoId) ?? videos[0] ?? null,
    [videos, selectedVideoId]
  );

  const videoClips = useMemo(
    () => (activeVideo ? clips.filter((c) => c.videoId === activeVideo.id) : []),
    [clips, activeVideo]
  );

  const activeClip = useMemo(
    () => videoClips.find((c) => c.id === selectedClipId) ?? videoClips[0] ?? null,
    [videoClips, selectedClipId]
  );

  const activeTranscription = useMemo(
    () => (activeVideo ? transcriptions.find((t) => t.videoId === activeVideo.id) ?? null : null),
    [transcriptions, activeVideo]
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [inspectorTab, setInspectorTab] = useState<'score' | 'subtitles' | 'transcript'>('score');
  const [previewSource, setPreviewSource] = useState<'live' | 'compiled'>('live');
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  const [draft, setDraft] = useState<ClipRecord | null>(activeClip);
  const [segmentsDraft, setSegmentsDraft] = useState<TranscriptSegment[]>(
    activeTranscription?.segments ?? []
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isCompiling, setIsCompiling] = useState(false);
  const [isRescoring, setIsRescoring] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    setDraft(activeClip);
    setPreviewSource('live');
    setFeedback(null);
    if (activeClip && videoRef.current) {
      videoRef.current.currentTime = activeClip.startTime;
      setCurrentTime(activeClip.startTime);
      setIsPlaying(false);
    }
  }, [activeClip?.id]);

  useEffect(() => {
    setSegmentsDraft(activeTranscription?.segments ?? []);
  }, [activeTranscription?.id, activeTranscription?.segments]);

  const handleTimeUpdate = () => {
    const el = videoRef.current;
    if (!el) return;
    const sec = el.currentTime;
    setCurrentTime(sec);
    if (previewSource === 'live' && draft && isPlaying && sec >= draft.endTime) {
      el.currentTime = draft.startTime;
    }
  };

  const togglePlay = () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) {
      if (
        previewSource === 'live' &&
        draft &&
        (el.currentTime < draft.startTime || el.currentTime >= draft.endTime)
      ) {
        el.currentTime = draft.startTime;
      }
      void el.play();
      setIsPlaying(true);
    } else {
      el.pause();
      setIsPlaying(false);
    }
  };

  const seekTo = (sec: number) => {
    const el = videoRef.current;
    if (!el || !activeVideo) return;
    const clamped = Math.max(0, Math.min(activeVideo.duration, sec));
    el.currentTime = clamped;
    setCurrentTime(clamped);
  };

  const activeSegment = useMemo(() => {
    const sec = previewSource === 'compiled' && draft ? draft.startTime + currentTime : currentTime;
    return segmentsDraft.find((seg) => sec >= seg.start && sec <= seg.end) ?? null;
  }, [segmentsDraft, currentTime, previewSource, draft]);

  const handleSaveDraft = async () => {
    if (!draft) return;
    setIsSaving(true);
    setFeedback(null);
    try {
      const updated = await onUpdateClip(draft.id, {
        title: draft.title,
        startTime: draft.startTime,
        endTime: draft.endTime,
        status: draft.status,
        aspectRatio: draft.aspectRatio,
        framingMode: draft.framingMode,
        cropX: draft.cropX,
        cropY: draft.cropY,
        zoom: draft.zoom,
        subtitleStyle: draft.subtitleStyle,
      });
      setDraft(updated);
      setFeedback({ type: 'ok', text: t.msgSaved });
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCompile = async () => {
    if (!draft) return;
    setIsCompiling(true);
    setFeedback(null);
    try {
      await onUpdateClip(draft.id, {
        title: draft.title,
        startTime: draft.startTime,
        endTime: draft.endTime,
        aspectRatio: draft.aspectRatio,
        framingMode: draft.framingMode,
        cropX: draft.cropX,
        cropY: draft.cropY,
        zoom: draft.zoom,
        subtitleStyle: draft.subtitleStyle,
      });
      const compiled = await onCompileClip(draft.id);
      setDraft(compiled);
      setPreviewSource('compiled');
      setFeedback({
        type: 'ok',
        text: `${t.compiledReady} (${compiled.aspectRatio} · ${formatBytes(compiled.exportedSizeBytes ?? 0)})`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Compilation failed',
      });
    } finally {
      setIsCompiling(false);
    }
  };

  const handleRescore = async (useAi: boolean) => {
    if (!draft) return;
    setIsRescoring(true);
    setFeedback(null);
    try {
      await onUpdateClip(draft.id, {
        startTime: draft.startTime,
        endTime: draft.endTime,
        title: draft.title,
      });
      const updated = await onRescoreClip(draft.id, useAi);
      setDraft(updated);
      setFeedback({
        type: 'ok',
        text: `${updated.score}/100 (${updated.scoringSource})`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Re-scoring failed',
      });
    } finally {
      setIsRescoring(false);
    }
  };

  const handleAddCustomClip = async () => {
    if (!activeVideo) return;
    const start = Math.max(0, Math.min(activeVideo.duration - 10, currentTime));
    const end = Math.min(activeVideo.duration, start + 18);
    const created = await onCreateClip(activeVideo.id, start, end);
    onSelectClip(created.id);
  };

  const handleSaveTranscriptSegments = async () => {
    if (!activeVideo) return;
    setIsSaving(true);
    try {
      await onSaveTranscript(activeVideo.id, segmentsDraft);
      setFeedback({ type: 'ok', text: t.msgTranscriptSaved });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Failed to save transcript',
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (!activeVideo) {
    return (
      <main className="mx-auto max-w-[1440px] px-6 py-16">
        <div className="mb-4 flex justify-end">
          <LanguageSwitch lang={lang} onChangeLang={onChangeLang} />
        </div>
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center dark:border-white/15 dark:bg-[#111318]">
          <Scissors className="mb-3 h-10 w-10 text-emerald-500" />
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
            {t.emptyTitle}
          </h2>
          <p className="mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">{t.emptyDesc}</p>
          <button
            type="button"
            onClick={onOpenUpload}
            className="mt-5 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
          >
            {tn.uploadVideo}
          </button>
        </div>
      </main>
    );
  }

  const clipDuration = draft ? Math.max(1, draft.endTime - draft.startTime) : 0;

  return (
    <main className="mx-auto max-w-[1440px] px-4 py-4 sm:px-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[270px_minmax(0,1fr)_340px]">
        {/* LEFT RAIL */}
        <aside className="flex flex-col rounded-xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111318] lg:h-[calc(100vh-104px)]">
          <div className="border-b border-slate-200 p-3 dark:border-white/10 space-y-2.5">
            <select
              value={activeVideo.id}
              onChange={(e) => onSelectVideo(Number(e.target.value))}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-white/10 dark:bg-[#181B22] dark:text-white"
            >
              {videos.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.title}
                </option>
              ))}
            </select>

            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                {t.detectedClips} ({videoClips.length})
              </span>
              <button
                type="button"
                onClick={handleAddCustomClip}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:text-slate-200 dark:hover:bg-white/5"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>{t.addClip}</span>
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {videoClips.length === 0 ? (
              <div className="p-4 text-center text-xs text-slate-500 dark:text-slate-400">
                {t.noClips}
              </div>
            ) : (
              videoClips.map((clip) => {
                const isSelected = draft?.id === clip.id;
                return (
                  <div
                    key={clip.id}
                    onClick={() => onSelectClip(clip.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') onSelectClip(clip.id);
                    }}
                    className={`cursor-pointer rounded-lg border p-2.5 transition-colors ${
                      isSelected
                        ? 'border-emerald-500 bg-emerald-500/10'
                        : 'border-transparent hover:bg-slate-50 dark:hover:bg-white/[0.04]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-900 dark:text-white line-clamp-2">
                        {clip.title}
                      </span>
                      <span className="font-mono text-xs font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums shrink-0">
                        {clip.score}
                      </span>
                    </div>

                    <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                      <span className="font-mono tabular-nums">
                        {formatTimecode(clip.startTime)}–{formatTimecode(clip.endTime)} ·{' '}
                        {Math.round(clip.endTime - clip.startTime)}s
                      </span>
                      <span>{t.statusLabels[clip.status]}</span>
                    </div>

                    <div
                      className="mt-2 flex items-center justify-between border-t border-slate-200/70 pt-1.5 dark:border-white/5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onUpdateClip(clip.id, { status: 'approved' })}
                          className={`rounded p-1 transition-colors ${
                            clip.status === 'approved' || clip.status === 'exported'
                              ? 'text-emerald-500 bg-emerald-500/10'
                              : 'text-slate-400 hover:text-emerald-500'
                          }`}
                          title={t.approveTitle}
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onUpdateClip(clip.id, { status: 'rejected' })}
                          className={`rounded p-1 transition-colors ${
                            clip.status === 'rejected'
                              ? 'text-red-500 bg-red-500/10'
                              : 'text-slate-400 hover:text-red-500'
                          }`}
                          title={t.rejectTitle}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={() => onDeleteClip(clip.id)}
                        className="rounded p-1 text-slate-400 hover:text-red-500"
                        title={t.deleteTitle}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* CENTER STAGE */}
        <section className="flex flex-col rounded-xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111318] lg:h-[calc(100vh-104px)]">
          {draft ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-2.5 dark:border-white/10">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-[#181B22]">
                    {(['9:16', '1:1', '16:9'] as AspectRatio[]).map((ratio) => (
                      <button
                        key={ratio}
                        type="button"
                        onClick={() => setDraft({ ...draft, aspectRatio: ratio })}
                        className={`rounded-md px-2.5 py-1 font-mono text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                          draft.aspectRatio === ratio
                            ? 'bg-white text-slate-900 shadow-sm dark:bg-[#252A36] dark:text-white'
                            : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                        }`}
                      >
                        {ratio}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-[#181B22]">
                    {(['crop', 'blur'] as FramingMode[]).map((fm) => (
                      <button
                        key={fm}
                        type="button"
                        onClick={() => setDraft({ ...draft, framingMode: fm })}
                        className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                          draft.framingMode === fm
                            ? 'bg-white text-slate-900 shadow-sm dark:bg-[#252A36] dark:text-white'
                            : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                        }`}
                      >
                        {fm === 'crop' ? t.smartCrop : t.blurFit}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <LanguageSwitch lang={lang} onChangeLang={onChangeLang} />

                  <button
                    type="button"
                    disabled={isSaving}
                    onClick={handleSaveDraft}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-white/10 dark:text-slate-200 dark:hover:bg-white/5 whitespace-nowrap shrink-0"
                  >
                    <Save className="h-3.5 w-3.5" />
                    <span>{tc.save}</span>
                  </button>

                  <button
                    type="button"
                    disabled={isCompiling}
                    onClick={handleCompile}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    {isCompiling ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Film className="h-3.5 w-3.5" />
                    )}
                    <span>{isCompiling ? t.compiling : t.compileExport}</span>
                  </button>
                </div>
              </div>

              {(feedback || draft.exportedUrl) && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs dark:border-white/10 dark:bg-white/[0.02]">
                  <div className="flex items-center gap-2">
                    {feedback && (
                      <span
                        className={
                          feedback.type === 'err'
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-emerald-600 dark:text-emerald-400'
                        }
                      >
                        {feedback.text}
                      </span>
                    )}
                    {!feedback && draft.exportedUrl && (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {t.compiledReady} ({formatBytes(draft.exportedSizeBytes ?? 0)})
                      </span>
                    )}
                  </div>

                  {draft.exportedUrl && (
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1 rounded-md bg-slate-200/70 p-0.5 dark:bg-[#181B22]">
                        <button
                          type="button"
                          onClick={() => setPreviewSource('live')}
                          className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                            previewSource === 'live'
                              ? 'bg-white text-slate-900 dark:bg-[#252A36] dark:text-white'
                              : 'text-slate-500 dark:text-slate-400'
                          }`}
                        >
                          {t.liveEdit}
                        </button>
                        <button
                          type="button"
                          onClick={() => setPreviewSource('compiled')}
                          className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                            previewSource === 'compiled'
                              ? 'bg-white text-slate-900 dark:bg-[#252A36] dark:text-white'
                              : 'text-slate-500 dark:text-slate-400'
                          }`}
                        >
                          {t.compiledMp4}
                        </button>
                      </div>

                      <a
                        href={`/api/clips/${draft.id}/download?format=mp4`}
                        className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-2.5 py-1 text-[11px] font-semibold text-slate-950 hover:bg-emerald-400"
                      >
                        <Download className="h-3 w-3" />
                        <span>MP4</span>
                      </a>
                      {draft.srtUrl && (
                        <a
                          href={`/api/clips/${draft.id}/download?format=srt`}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 dark:border-white/15 dark:text-slate-200 dark:hover:bg-white/5"
                        >
                          <Download className="h-3 w-3" />
                          <span>SRT</span>
                        </a>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Video Stage */}
              <div className="flex flex-1 items-center justify-center overflow-hidden bg-slate-950 p-4">
                <div
                  className={`relative overflow-hidden rounded-lg border border-white/15 bg-black shadow-2xl ${
                    draft.aspectRatio === '9:16'
                      ? 'aspect-[9/16] h-full max-h-[430px]'
                      : draft.aspectRatio === '1:1'
                      ? 'aspect-square h-full max-h-[410px]'
                      : 'aspect-video w-full max-w-[680px]'
                  }`}
                >
                  <video
                    ref={videoRef}
                    key={`${previewSource}-${draft.exportedUrl ?? activeVideo.fileUrl}`}
                    src={
                      previewSource === 'compiled' && draft.exportedUrl
                        ? draft.exportedUrl
                        : activeVideo.fileUrl
                    }
                    muted={isMuted}
                    playsInline
                    onTimeUpdate={handleTimeUpdate}
                    onEnded={() => setIsPlaying(false)}
                    onClick={togglePlay}
                    className="h-full w-full cursor-pointer"
                    style={
                      previewSource === 'compiled'
                        ? { objectFit: 'contain' }
                        : draft.framingMode === 'blur'
                        ? {
                            objectFit: 'contain',
                            transform: `scale(${draft.zoom})`,
                          }
                        : {
                            objectFit: 'cover',
                            objectPosition: `${draft.cropX}% ${draft.cropY}%`,
                            transform: `scale(${draft.zoom})`,
                          }
                    }
                  />

                  {previewSource === 'live' &&
                    draft.subtitleStyle.enabled &&
                    activeSegment && (
                      <div
                        className={`pointer-events-none absolute inset-x-4 flex ${
                          draft.subtitleStyle.position === 'top'
                            ? 'top-6'
                            : draft.subtitleStyle.position === 'center'
                            ? 'top-1/2 -translate-y-1/2'
                            : 'bottom-6'
                        } ${
                          draft.subtitleStyle.alignment === 'left'
                            ? 'justify-start text-left'
                            : draft.subtitleStyle.alignment === 'right'
                            ? 'justify-end text-right'
                            : 'justify-center text-center'
                        }`}
                      >
                        <div
                          className={`max-w-[92%] rounded-md px-3 py-1.5 font-display font-bold leading-snug ${
                            draft.subtitleStyle.backgroundBox ? 'bg-black/75' : ''
                          }`}
                          style={{
                            fontSize: `${Math.max(12, Math.round(draft.subtitleStyle.fontSize * 0.72))}px`,
                            color: draft.subtitleStyle.textColor,
                            textShadow: draft.subtitleStyle.backgroundBox
                              ? 'none'
                              : '0 2px 6px rgba(0,0,0,0.95)',
                          }}
                        >
                          {activeSegment.text.split(/\s+/).map((word, idx, arr) => {
                            const segDur = Math.max(0.5, activeSegment.end - activeSegment.start);
                            const progress = (currentTime - activeSegment.start) / segDur;
                            const activeWordIdx = Math.floor(progress * arr.length);
                            const isWordActive = idx === activeWordIdx;
                            return (
                              <span
                                key={`${activeSegment.id}-${idx}`}
                                style={{
                                  color: isWordActive
                                    ? draft.subtitleStyle.highlightColor
                                    : draft.subtitleStyle.textColor,
                                }}
                              >
                                {word}{' '}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    )}
                </div>
              </div>

              {/* Transport & Timeline */}
              <div className="border-t border-slate-200 p-4 dark:border-white/10 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => seekTo(draft.startTime)}
                      className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-white"
                      title={t.start}
                    >
                      <RotateCcw className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={togglePlay}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500 text-slate-950 hover:bg-emerald-400"
                    >
                      {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsMuted((m) => !m)}
                      className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-white"
                    >
                      {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                    </button>
                    <span className="font-mono text-xs text-slate-700 dark:text-slate-200 tabular-nums">
                      {formatTimecode(currentTime, true)} / {formatTimecode(activeVideo.duration, true)}
                    </span>
                  </div>

                  <div className="font-mono text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    {t.clipWindow}: {formatTimecode(draft.startTime, true)} →{' '}
                    {formatTimecode(draft.endTime, true)} ({clipDuration.toFixed(1)}s)
                  </div>
                </div>

                <div
                  className="relative h-8 cursor-pointer rounded-md bg-slate-100 dark:bg-[#181B22]"
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                    seekTo(pct * activeVideo.duration);
                  }}
                >
                  <div
                    className="absolute inset-y-1 rounded border border-emerald-500 bg-emerald-500/20"
                    style={{
                      left: `${(draft.startTime / Math.max(1, activeVideo.duration)) * 100}%`,
                      width: `${((draft.endTime - draft.startTime) / Math.max(1, activeVideo.duration)) * 100}%`,
                    }}
                  />
                  <div
                    className="absolute inset-y-0 w-0.5 bg-slate-900 dark:bg-white"
                    style={{
                      left: `${(currentTime / Math.max(1, activeVideo.duration)) * 100}%`,
                    }}
                  />
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-1.5 dark:border-white/10">
                    <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                      {t.start}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            startTime: Math.max(0, Math.round((draft.startTime - 0.5) * 10) / 10),
                          })
                        }
                        className="rounded border border-slate-200 px-1.5 py-0.5 font-mono text-[11px] hover:bg-slate-100 dark:border-white/10 dark:hover:bg-white/5"
                      >
                        -0.5s
                      </button>
                      <span className="font-mono text-xs font-semibold text-slate-900 dark:text-white tabular-nums">
                        {formatTimecode(draft.startTime, true)}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            startTime: Math.min(
                              draft.endTime - 2,
                              Math.round((draft.startTime + 0.5) * 10) / 10
                            ),
                          })
                        }
                        className="rounded border border-slate-200 px-1.5 py-0.5 font-mono text-[11px] hover:bg-slate-100 dark:border-white/10 dark:hover:bg-white/5"
                      >
                        +0.5s
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-1.5 dark:border-white/10">
                    <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                      {t.end}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            endTime: Math.max(
                              draft.startTime + 2,
                              Math.round((draft.endTime - 0.5) * 10) / 10
                            ),
                          })
                        }
                        className="rounded border border-slate-200 px-1.5 py-0.5 font-mono text-[11px] hover:bg-slate-100 dark:border-white/10 dark:hover:bg-white/5"
                      >
                        -0.5s
                      </button>
                      <span className="font-mono text-xs font-semibold text-slate-900 dark:text-white tabular-nums">
                        {formatTimecode(draft.endTime, true)}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            endTime: Math.min(
                              activeVideo.duration,
                              Math.round((draft.endTime + 0.5) * 10) / 10
                            ),
                          })
                        }
                        className="rounded border border-slate-200 px-1.5 py-0.5 font-mono text-[11px] hover:bg-slate-100 dark:border-white/10 dark:hover:bg-white/5"
                      >
                        +0.5s
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-sm text-slate-500">
              {t.selectClipPrompt}
            </div>
          )}
        </section>

        {/* RIGHT INSPECTOR */}
        <aside className="flex flex-col rounded-xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111318] lg:h-[calc(100vh-104px)]">
          <div className="border-b border-slate-200 p-2 dark:border-white/10">
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-[#181B22]">
              {(['score', 'subtitles', 'transcript'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setInspectorTab(tab)}
                  className={`rounded-md py-1.5 text-xs font-medium transition-colors ${
                    inspectorTab === tab
                      ? 'bg-white text-slate-900 shadow-sm dark:bg-[#252A36] dark:text-white'
                      : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                  }`}
                >
                  {tab === 'score'
                    ? t.tabScore
                    : tab === 'subtitles'
                    ? t.tabSubtitles
                    : t.tabTranscript}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {inspectorTab === 'score' && draft && (
              <div className="space-y-5">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-500 dark:text-slate-400">
                    {t.clipTitle}
                  </label>
                  <input
                    type="text"
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-white/10 dark:bg-[#181B22] dark:text-white"
                  />
                </div>

                <div className="space-y-3 border-t border-slate-200 pt-4 dark:border-white/10">
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                      {t.rubricTitle}
                    </span>
                    <span className="font-mono text-xl font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                      {draft.score}/100
                    </span>
                  </div>

                  {[
                    { label: t.critHook, val: draft.breakdown.hook, max: scoringConfig.hookWeight },
                    {
                      label: t.critInfo,
                      val: draft.breakdown.infoValue,
                      max: scoringConfig.infoWeight,
                    },
                    {
                      label: t.critEmotion,
                      val: draft.breakdown.emotion,
                      max: scoringConfig.emotionWeight,
                    },
                    {
                      label: t.critSelf,
                      val: draft.breakdown.selfContained,
                      max: scoringConfig.selfContainedWeight,
                    },
                    {
                      label: t.critDuration,
                      val: draft.breakdown.durationFit,
                      max: scoringConfig.durationWeight,
                    },
                  ].map((item) => {
                    const pct =
                      item.max > 0 ? Math.min(100, Math.round((item.val / item.max) * 100)) : 0;
                    return (
                      <div key={item.label} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-slate-600 dark:text-slate-400">{item.label}</span>
                          <span className="font-mono font-medium text-slate-900 dark:text-white tabular-nums">
                            {item.val}/{item.max}
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-white/10">
                          <div
                            className="h-full bg-emerald-500 transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="space-y-2 border-t border-slate-200 pt-4 dark:border-white/10 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500 dark:text-slate-400">{t.hookTypeLabel}</span>
                    <span className="font-medium text-slate-900 dark:text-white">
                      {draft.hookType || 'Standard Opener'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500 dark:text-slate-400">{t.contextLabel}</span>
                    <span
                      className={`font-medium ${
                        draft.contextStatus === 'needs-context'
                          ? 'text-red-600 dark:text-red-400'
                          : draft.contextStatus === 'partial'
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-emerald-600 dark:text-emerald-400'
                      }`}
                    >
                      {t.contextValues[draft.contextStatus ?? 'self-contained']}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500 dark:text-slate-400">{t.sceneCutsLabel}</span>
                    <span className="font-mono font-medium text-slate-900 dark:text-white tabular-nums">
                      {draft.sceneChanges ?? 0}
                    </span>
                  </div>
                </div>

                <div className="space-y-1.5 border-t border-slate-200 pt-4 dark:border-white/10">
                  <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                    {t.rationale} ({draft.scoringSource})
                  </div>
                  <p className="text-xs leading-relaxed text-slate-700 dark:text-slate-300">
                    {draft.reason}
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-2 border-t border-slate-200 pt-4 dark:border-white/10">
                  <button
                    type="button"
                    disabled={isRescoring}
                    onClick={() => handleRescore(false)}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-white/10 dark:text-slate-200 dark:hover:bg-white/5"
                  >
                    <span>{t.rescoreHeuristic}</span>
                  </button>
                  <button
                    type="button"
                    disabled={isRescoring}
                    onClick={() => handleRescore(true)}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-500/20 disabled:opacity-50 dark:text-emerald-300"
                  >
                    {isRescoring ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    <span>{geminiConfigured ? t.rescoreGemini : t.rescoreGeminiNeedsKey}</span>
                  </button>
                </div>
              </div>
            )}

            {inspectorTab === 'subtitles' && draft && (
              <div className="space-y-5">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-900 dark:text-white">
                    <Subtitles className="h-4 w-4 text-emerald-500" />
                    <span>{t.burnedSubtitles}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        subtitleStyle: {
                          ...draft.subtitleStyle,
                          enabled: !draft.subtitleStyle.enabled,
                        },
                      })
                    }
                    className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                      draft.subtitleStyle.enabled
                        ? 'bg-emerald-500 text-slate-950'
                        : 'bg-slate-200 text-slate-600 dark:bg-white/10 dark:text-slate-400'
                    }`}
                  >
                    {draft.subtitleStyle.enabled ? t.enabled : t.off}
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {subtitlePresets.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          subtitleStyle: { ...draft.subtitleStyle, ...p.style },
                        })
                      }
                      className={`rounded-lg border px-2.5 py-2 text-left text-xs font-medium transition-colors ${
                        draft.subtitleStyle.preset === p.id
                          ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                          : 'border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/5'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                <div className="space-y-3 border-t border-slate-200 pt-4 dark:border-white/10">
                  <div>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="text-slate-500 dark:text-slate-400">{t.fontSize}</span>
                      <span className="font-mono text-slate-900 dark:text-white tabular-nums">
                        {draft.subtitleStyle.fontSize}px
                      </span>
                    </div>
                    <input
                      type="range"
                      min={14}
                      max={34}
                      value={draft.subtitleStyle.fontSize}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          subtitleStyle: {
                            ...draft.subtitleStyle,
                            fontSize: Number(e.target.value),
                          },
                        })
                      }
                      className="w-full accent-emerald-500"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
                        {t.textColor}
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={draft.subtitleStyle.textColor}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              subtitleStyle: {
                                ...draft.subtitleStyle,
                                textColor: e.target.value,
                              },
                            })
                          }
                          className="h-7 w-8 cursor-pointer rounded border border-slate-200 bg-transparent dark:border-white/15"
                        />
                        <span className="font-mono text-xs text-slate-700 dark:text-slate-300">
                          {draft.subtitleStyle.textColor}
                        </span>
                      </div>
                    </div>

                    <div>
                      <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
                        {t.wordHighlight}
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={draft.subtitleStyle.highlightColor}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              subtitleStyle: {
                                ...draft.subtitleStyle,
                                highlightColor: e.target.value,
                              },
                            })
                          }
                          className="h-7 w-8 cursor-pointer rounded border border-slate-200 bg-transparent dark:border-white/15"
                        />
                        <span className="font-mono text-xs text-slate-700 dark:text-slate-300">
                          {draft.subtitleStyle.highlightColor}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
                        {t.position}
                      </label>
                      <select
                        value={draft.subtitleStyle.position}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            subtitleStyle: {
                              ...draft.subtitleStyle,
                              position: e.target.value as SubtitleStyle['position'],
                            },
                          })
                        }
                        className="w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-900 dark:border-white/10 dark:bg-[#181B22] dark:text-white"
                      >
                        <option value="bottom">{t.posBottom}</option>
                        <option value="center">{t.posCenter}</option>
                        <option value="top">{t.posTop}</option>
                      </select>
                    </div>

                    <div>
                      <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
                        {t.alignment}
                      </label>
                      <select
                        value={draft.subtitleStyle.alignment}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            subtitleStyle: {
                              ...draft.subtitleStyle,
                              alignment: e.target.value as SubtitleStyle['alignment'],
                            },
                          })
                        }
                        className="w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-900 dark:border-white/10 dark:bg-[#181B22] dark:text-white"
                      >
                        <option value="left">{t.alignLeft}</option>
                        <option value="center">{t.alignCenter}</option>
                        <option value="right">{t.alignRight}</option>
                      </select>
                    </div>
                  </div>

                  <label className="flex items-center justify-between text-xs text-slate-700 dark:text-slate-300">
                    <span>{t.backdropBox}</span>
                    <input
                      type="checkbox"
                      checked={draft.subtitleStyle.backgroundBox}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          subtitleStyle: {
                            ...draft.subtitleStyle,
                            backgroundBox: e.target.checked,
                          },
                        })
                      }
                      className="h-4 w-4 accent-emerald-500"
                    />
                  </label>
                </div>

                <div className="space-y-3 border-t border-slate-200 pt-4 dark:border-white/10">
                  <div className="text-xs font-semibold text-slate-900 dark:text-white">
                    {t.cropFocusZoom}
                  </div>
                  <div>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="text-slate-500 dark:text-slate-400">{t.horizontalX}</span>
                      <span className="font-mono text-slate-900 dark:text-white tabular-nums">
                        {draft.cropX}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={draft.cropX}
                      onChange={(e) => setDraft({ ...draft, cropX: Number(e.target.value) })}
                      className="w-full accent-emerald-500"
                    />
                  </div>
                  <div>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="text-slate-500 dark:text-slate-400">{t.verticalY}</span>
                      <span className="font-mono text-slate-900 dark:text-white tabular-nums">
                        {draft.cropY}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={draft.cropY}
                      onChange={(e) => setDraft({ ...draft, cropY: Number(e.target.value) })}
                      className="w-full accent-emerald-500"
                    />
                  </div>
                  <div>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="text-slate-500 dark:text-slate-400">{t.scaleZoom}</span>
                      <span className="font-mono text-slate-900 dark:text-white tabular-nums">
                        {draft.zoom.toFixed(2)}x
                      </span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={2}
                      step={0.05}
                      value={draft.zoom}
                      onChange={(e) => setDraft({ ...draft, zoom: Number(e.target.value) })}
                      className="w-full accent-emerald-500"
                    />
                  </div>
                </div>
              </div>
            )}

            {inspectorTab === 'transcript' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                    {t.syncedSegments} ({segmentsDraft.length})
                  </span>
                  <button
                    type="button"
                    disabled={isSaving || segmentsDraft.length === 0}
                    onClick={handleSaveTranscriptSegments}
                    className="rounded-md bg-emerald-500 px-2.5 py-1 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
                  >
                    {t.saveText}
                  </button>
                </div>

                {segmentsDraft.length === 0 ? (
                  <p className="text-xs text-slate-500 dark:text-slate-400">{t.noSegments}</p>
                ) : (
                  <div className="space-y-2">
                    {segmentsDraft.map((seg, idx) => {
                      const isCurrent = activeSegment?.id === seg.id;
                      return (
                        <div
                          key={seg.id}
                          className={`rounded-lg border p-2.5 transition-colors ${
                            isCurrent
                              ? 'border-emerald-500 bg-emerald-500/10'
                              : 'border-slate-200 dark:border-white/10'
                          }`}
                        >
                          <div className="mb-1.5 flex items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setPreviewSource('live');
                                seekTo(seg.start);
                              }}
                              className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-emerald-700 hover:bg-emerald-500/20 dark:bg-white/10 dark:text-emerald-400 tabular-nums"
                            >
                              {formatTimecode(seg.start)}
                            </button>

                            {draft && (
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setDraft({
                                      ...draft,
                                      startTime: Math.min(seg.start, draft.endTime - 2),
                                    })
                                  }
                                  className="rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-white/10"
                                >
                                  {t.setStart}
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setDraft({
                                      ...draft,
                                      endTime: Math.max(seg.end, draft.startTime + 2),
                                    })
                                  }
                                  className="rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-white/10"
                                >
                                  {t.setEnd}
                                </button>
                              </div>
                            )}
                          </div>

                          <textarea
                            rows={2}
                            value={seg.text}
                            onChange={(e) => {
                              const next = [...segmentsDraft];
                              next[idx] = { ...seg, text: e.target.value };
                              setSegmentsDraft(next);
                            }}
                            className="w-full resize-none bg-transparent text-xs leading-relaxed text-slate-800 focus:outline-none dark:text-slate-200"
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
};
