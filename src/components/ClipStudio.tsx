import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Download,
  Film,
  Loader2,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Scissors,
  Sparkles,
  Subtitles,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { TRANSLATIONS, type Language } from '../i18n';
import type {
  ClipRecord,
  ClipComposition,
  CompositionRegion,
  CompositionKeyframe,
  ScoringConfig,
  SubtitleStyle,
  TranscriptSegment,
  TimelineSegment,
  TranscriptionRecord,
  VideoRecord,
} from '../types';
import {
  ensureClipCompositions,
  getClipComposition,
  type CompositionVariant,
} from '../utils/composition';
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
  onCompileClip: (clipId: number, variant?: CompositionVariant) => Promise<ClipRecord>;
  onRescoreClip: (clipId: number, useAi: boolean) => Promise<ClipRecord>;
  onCreateClip: (videoId: number, startTime: number, endTime: number) => Promise<ClipRecord>;
  onDeleteClip: (clipId: number) => Promise<void>;
  onSaveTranscript: (videoId: number, segments: TranscriptSegment[]) => Promise<void>;
  onImportSrt: (videoId: number, file: File) => Promise<{ importedCount: number }>;
  onOpenUpload: () => void;
  lang: Language;
  onChangeLang: (lang: Language) => void;
}

const FocusRegionBox: React.FC<{
  label: string;
  color: 'cyan' | 'fuchsia' | 'emerald';
  region: CompositionRegion;
  onChange: (region: CompositionRegion) => void;
}> = ({ label, color, region, onChange }) => {
  const interaction = useRef<{
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    initial: CompositionRegion;
    containerWidth: number;
    containerHeight: number;
  } | null>(null);

  const begin = (event: React.PointerEvent<HTMLDivElement>, mode: 'move' | 'resize') => {
    event.preventDefault();
    event.stopPropagation();
    const container = event.currentTarget.closest('[data-focus-canvas]')?.getBoundingClientRect();
    if (!container) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    interaction.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      initial: { ...region },
      containerWidth: container.width,
      containerHeight: container.height,
    };
  };

  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const active = interaction.current;
    if (!active) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = ((event.clientX - active.startX) / active.containerWidth) * 100;
    const dy = ((event.clientY - active.startY) / active.containerHeight) * 100;
    if (active.mode === 'move') {
      onChange({
        ...active.initial,
        x: Math.min(100 - active.initial.width, Math.max(0, active.initial.x + dx)),
        y: Math.min(100 - active.initial.height, Math.max(0, active.initial.y + dy)),
      });
    } else {
      onChange({
        ...active.initial,
        width: Math.min(100 - active.initial.x, Math.max(8, active.initial.width + dx)),
        height: Math.min(100 - active.initial.y, Math.max(8, active.initial.height + dy)),
      });
    }
  };

  const end = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    interaction.current = null;
  };

  const border = color === 'cyan' ? 'border-cyan-400' : color === 'emerald' ? 'border-emerald-400' : 'border-fuchsia-400';
  const badge = color === 'cyan'
    ? 'bg-cyan-400 text-slate-950'
    : color === 'emerald'
    ? 'bg-emerald-500 text-slate-950'
    : 'bg-fuchsia-500 text-white';

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${label}: drag to move, use the corner handle to resize`}
      onPointerDown={(event) => begin(event, 'move')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      className={`absolute touch-none cursor-move border-2 ${border} bg-black/5 shadow-[0_0_0_1px_rgba(0,0,0,0.45)]`}
      style={{ left: `${region.x}%`, top: `${region.y}%`, width: `${region.width}%`, height: `${region.height}%` }}
    >
      <span className={`absolute left-0 top-0 px-2 py-1 text-[10px] font-bold tracking-wide ${badge}`}>
        {label}
      </span>
      <div
        onPointerDown={(event) => begin(event, 'resize')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        className={`absolute -bottom-2 -right-2 h-5 w-5 cursor-nwse-resize rounded-sm border-2 border-white ${badge}`}
        title="Resize"
      />
    </div>
  );
};

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
  onImportSrt,
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
  const compositionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewDrawRef = useRef<() => void>(() => {});
  const pendingSeekRef = useRef<number | null>(null);
  const timelinePlaybackIndexRef = useRef(0);
  const resumeTimelinePlaybackRef = useRef(false);
  const [inspectorTab, setInspectorTab] = useState<'score' | 'subtitles' | 'transcript'>('score');
  const [previewSource, setPreviewSource] = useState<'live' | 'compiled'>(
    activeClip?.exportedUrl ? 'compiled' : 'live'
  );
  const [activeVariant, setActiveVariant] = useState<CompositionVariant>('vertical');
  const [compositionView, setCompositionView] = useState<'edit' | 'preview'>('edit');
  const [hasLiveEdits, setHasLiveEdits] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [selectedTimelineSegmentId, setSelectedTimelineSegmentId] = useState<string | null>(null);
  const [draggedTimelineSegmentId, setDraggedTimelineSegmentId] = useState<string | null>(null);
  const [timelineMenuSegmentId, setTimelineMenuSegmentId] = useState<string | null>(null);
  const [timelineUndoSegments, setTimelineUndoSegments] = useState<TimelineSegment[] | null>(null);
  const [recentSplit, setRecentSplit] = useState<{ leftId: string; rightId: string } | null>(null);
  const [liveWindow, setLiveWindow] = useState<{ start: number; end: number }>({
    start: Math.max(0, Math.floor((activeClip?.startTime ?? 0) - 4)),
    end: Math.min(
      Math.max(1, activeVideo?.duration ?? 60),
      Math.ceil((activeClip?.endTime ?? 30) + 4)
    ),
  });

  const [draft, setDraft] = useState<ClipRecord | null>(activeClip);
  const [segmentsDraft, setSegmentsDraft] = useState<TranscriptSegment[]>(
    activeTranscription?.segments ?? []
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isCompiling, setIsCompiling] = useState(false);
  const [isRescoring, setIsRescoring] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [fallbackMode, setFallbackMode] = useState<'none' | 'mp4' | 'webm'>('none');
  const [isFallbackLoading, setIsFallbackLoading] = useState(false);
  const [isDetectingCamera, setIsDetectingCamera] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const computeWindowForRange = (startSec: number, endSec: number, totalDur: number) => {
    const safeDur = Math.max(1, totalDur);
    const start = Math.max(0, Math.floor(startSec - 4));
    const desiredEnd = Math.ceil(Math.max(start + 12, endSec + 4));
    const end = Math.min(safeDur, Math.min(desiredEnd, start + 70));
    return { start, end };
  };

  const isLargeOrLongVideo = Boolean(
    activeVideo && (activeVideo.sizeBytes > 60 * 1024 * 1024 || activeVideo.duration > 90)
  );
  const isUsingWindowedLive =
    previewSource === 'live' && Boolean(activeVideo) && (isLargeOrLongVideo || fallbackMode !== 'none');
  const windowOffset = isUsingWindowedLive ? liveWindow.start : 0;
  const editedTimelineDuration = draft
    ? (draft.timelineSegments?.length
      ? draft.timelineSegments.reduce((sum, segment) => sum + segment.end - segment.start, 0)
      : draft.endTime - draft.startTime)
    : 0;
  const logicalPlayheadTime = (() => {
    if (!draft || previewSource === 'compiled') return currentTime;
    const timeline = draft.timelineSegments?.length
      ? draft.timelineSegments
      : [{ id: `clip-${draft.id}-base`, start: draft.startTime, end: draft.endTime }];
    let offset = 0;
    for (const segment of timeline) {
      if (currentTime >= segment.start && currentTime <= segment.end) {
        return offset + currentTime - segment.start;
      }
      offset += segment.end - segment.start;
    }
    return 0;
  })();
  const variantKeyframes = draft?.compositionKeyframes?.[activeVariant] ?? [];
  const activeCompositionKeyframe = [...variantKeyframes]
    .sort((a, b) => a.time - b.time)
    .filter((frame) => frame.time <= logicalPlayheadTime + 0.001)
    .at(-1) ?? null;
  const activeComposition = draft
    ? activeCompositionKeyframe?.composition ?? getClipComposition(draft, activeVariant)
    : null;
  const activeVariantExport = draft?.exportVariants?.[activeVariant];
  const subtitleRegion: CompositionRegion = draft?.subtitleStyle.region ?? {
    x: 8,
    y: 72,
    width: 84,
    height: 20,
  };
  const isSubtitleWorkspace = Boolean(
    compositionView === 'edit' &&
    inspectorTab === 'subtitles' &&
    draft?.subtitleStyle.enabled
  );
  const isSubtitleEditing = previewSource === 'live' && isSubtitleWorkspace;

  const resolvedVideoSrc = useMemo(() => {
    if (previewSource === 'compiled') {
      return activeVariantExport?.exportedUrl ?? (activeVariant === 'vertical' ? draft?.exportedUrl ?? '' : '');
    }
    if (!activeVideo?.fileUrl) return '';
    if (isUsingWindowedLive) {
      const fmt = fallbackMode === 'webm' ? 'webm' : 'mp4';
      return `/api/videos/${activeVideo.id}/preview?start=${liveWindow.start}&end=${liveWindow.end}&format=${fmt}`;
    }
    return activeVideo.fileUrl;
  }, [previewSource, activeVariantExport?.exportedUrl, draft?.exportedUrl, activeVariant, activeVideo, isUsingWindowedLive, fallbackMode, liveWindow.start, liveWindow.end]);

  useEffect(() => {
    setFallbackMode('none');
    setMediaError(null);
    setIsFallbackLoading(false);
  }, [activeVideo?.id, previewSource, draft?.exportedUrl]);

  useEffect(() => {
    setDraft(activeClip);
    setActiveVariant('vertical');
    const startMode = activeClip?.exportedUrl ? 'compiled' : 'live';
    setPreviewSource(startMode);
    setHasLiveEdits(false);
    setFeedback(null);
    setMediaError(null);
    setIsPlaying(false);
    pendingSeekRef.current = null;
    setSelectedTimelineSegmentId(activeClip?.timelineSegments?.[0]?.id ?? null);
    setTimelineMenuSegmentId(null);
    setTimelineUndoSegments(null);
    setRecentSplit(null);
    if (activeClip && activeVideo) {
      setLiveWindow(
        computeWindowForRange(activeClip.startTime, activeClip.endTime, activeVideo.duration)
      );
    }
    if (startMode === 'compiled') {
      setCurrentTime(0);
    } else if (activeClip) {
      setCurrentTime(activeClip.startTime);
    }
  }, [activeClip?.id]);

  // Keep draft synced if parent workspace refreshes with newly rendered exportedUrl
  useEffect(() => {
    if (activeClip && draft && activeClip.id === draft.id && !draft.exportedUrl && activeClip.exportedUrl) {
      setDraft(activeClip);
      if (!hasLiveEdits) {
        setPreviewSource('compiled');
        setCurrentTime(0);
      }
    }
  }, [activeClip?.exportedUrl]);

  useEffect(() => {
    setSegmentsDraft(activeTranscription?.segments ?? []);
  }, [activeTranscription?.id, activeTranscription?.segments]);

  const updateDraftLive = (next: ClipRecord) => {
    setDraft(next);
    if (previewSource === 'compiled') {
      setPreviewSource('live');
      setHasLiveEdits(true);
      setCurrentTime(next.startTime);
    } else {
      setHasLiveEdits(true);
    }
    if (activeVideo && (next.startTime < liveWindow.start || next.endTime > liveWindow.end)) {
      setLiveWindow(computeWindowForRange(next.startTime, next.endTime, activeVideo.duration));
    }
  };

  const getTimelineSegments = (clip: ClipRecord): TimelineSegment[] =>
    clip.timelineSegments?.length
      ? clip.timelineSegments
      : [{ id: `clip-${clip.id}-base`, start: clip.startTime, end: clip.endTime }];

  const updateTimelineSegments = (segments: TimelineSegment[]) => {
    if (!draft || segments.length === 0) return;
    updateDraftLive({
      ...draft,
      timelineSegments: segments,
      startTime: Math.min(...segments.map((segment) => segment.start)),
      endTime: Math.max(...segments.map((segment) => segment.end)),
    });
    if (!segments.some((segment) => segment.id === selectedTimelineSegmentId)) {
      setSelectedTimelineSegmentId(segments[0].id);
    }
  };

  const seekToEditedTime = (time: number) => {
    if (!draft) return;
    const timeline = getTimelineSegments(draft);
    let offset = 0;
    for (const segment of timeline) {
      const duration = segment.end - segment.start;
      if (time <= offset + duration) {
        seekTo(segment.start + Math.max(0, time - offset));
        return;
      }
      offset += duration;
    }
    seekTo(timeline[timeline.length - 1].end);
  };

  const splitTimelineAtPlayhead = () => {
    if (!draft || previewSource === 'compiled') return;
    const segments = getTimelineSegments(draft);
    const index = segments.findIndex((segment) => currentTime > segment.start + 0.1 && currentTime < segment.end - 0.1);
    if (index < 0) {
      setFeedback({ type: 'err', text: 'Place the playhead inside a segment before cutting.' });
      return;
    }
    const source = segments[index];
    const splitAt = Math.round(currentTime * 1000) / 1000;
    const next = [...segments];
    const left = { ...source, id: `${source.id}-a-${Date.now()}`, end: splitAt };
    const right = { ...source, id: `${source.id}-b-${Date.now()}`, start: splitAt };
    next.splice(index, 1, left, right);
    setTimelineUndoSegments(segments);
    updateTimelineSegments(next);
    setSelectedTimelineSegmentId(right.id);
    setRecentSplit({ leftId: left.id, rightId: right.id });
    setFeedback({ type: 'ok', text: `Cut created at ${formatTimecode(splitAt, true)}.` });
  };

  const applyTimelineRemoval = (next: TimelineSegment[], message: string) => {
    if (!draft || next.length === 0) {
      setFeedback({ type: 'err', text: 'La timeline debe conservar al menos un fragmento.' });
      return;
    }
    const segments = getTimelineSegments(draft);
    setTimelineUndoSegments(segments);
    updateTimelineSegments(next);
    setTimelineMenuSegmentId(null);
    setRecentSplit(null);
    setFeedback({ type: 'ok', text: message });
  };

  const deleteTimelineSegment = (segmentId: string) => {
    if (!draft) return;
    const segments = getTimelineSegments(draft);
    if (segments.length <= 1) {
      setFeedback({ type: 'err', text: 'No puedes eliminar el único fragmento de la timeline.' });
      return;
    }
    const index = segments.findIndex((segment) => segment.id === segmentId);
    const next = segments.filter((segment) => segment.id !== segmentId);
    applyTimelineRemoval(next, 'Fragmento eliminado. Puedes deshacer la acción.');
    const fallback = next[Math.min(Math.max(0, index), next.length - 1)];
    setSelectedTimelineSegmentId(fallback.id);
    seekTo(fallback.start);
  };

  const undoTimelineEdit = () => {
    if (!timelineUndoSegments) return;
    const current = draft ? getTimelineSegments(draft) : null;
    updateTimelineSegments(timelineUndoSegments);
    setTimelineUndoSegments(current);
    setFeedback({ type: 'ok', text: 'Edición de timeline restaurada.' });
  };

  const reorderTimelineSegment = (targetId: string) => {
    if (!draft || !draggedTimelineSegmentId || draggedTimelineSegmentId === targetId) return;
    const segments = [...getTimelineSegments(draft)];
    const from = segments.findIndex((segment) => segment.id === draggedTimelineSegmentId);
    const to = segments.findIndex((segment) => segment.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = segments.splice(from, 1);
    segments.splice(to, 0, moved);
    setTimelineUndoSegments(getTimelineSegments(draft));
    updateTimelineSegments(segments);
    setDraggedTimelineSegmentId(null);
  };

  const updateComposition = (patch: Partial<ClipComposition>) => {
    if (!draft) return;
    const compositions = ensureClipCompositions(draft);
    const nextComposition = { ...(activeComposition ?? compositions[activeVariant]), ...patch };
    if (activeCompositionKeyframe) {
      const nextFrames = variantKeyframes.map((frame) =>
        frame.id === activeCompositionKeyframe.id
          ? { ...frame, composition: nextComposition }
          : frame
      );
      updateDraftLive({
        ...draft,
        aspectRatio: nextComposition.aspectRatio,
        compositionKeyframes: { ...(draft.compositionKeyframes ?? {}), [activeVariant]: nextFrames },
      });
      return;
    }
    updateDraftLive({
      ...draft,
      aspectRatio: nextComposition.aspectRatio,
      compositions: { ...compositions, [activeVariant]: nextComposition },
    });
  };

  const addCompositionKeyframe = () => {
    if (!draft || !activeComposition) return;
    const time = Math.max(0, Math.min(editedTimelineDuration, Math.round(logicalPlayheadTime * 1000) / 1000));
    const existing = variantKeyframes.find((frame) => Math.abs(frame.time - time) < 0.05);
    if (existing) {
      setFeedback({ type: 'err', text: 'Ya existe un keyframe en esta posición.' });
      return;
    }
    const frame: CompositionKeyframe = {
      id: `composition-${activeVariant}-${Date.now()}`,
      time,
      composition: { ...activeComposition, camera: { ...activeComposition.camera }, content: { ...activeComposition.content } },
    };
    updateDraftLive({
      ...draft,
      compositionKeyframes: {
        ...(draft.compositionKeyframes ?? {}),
        [activeVariant]: [...variantKeyframes, frame].sort((a, b) => a.time - b.time),
      },
    });
    setFeedback({ type: 'ok', text: `Keyframe añadido en ${formatTimecode(time, true)}. Ajusta Cámara o Contenido.` });
  };

  const removeActiveCompositionKeyframe = () => {
    if (!draft || !activeCompositionKeyframe) return;
    updateDraftLive({
      ...draft,
      compositionKeyframes: {
        ...(draft.compositionKeyframes ?? {}),
        [activeVariant]: variantKeyframes.filter((frame) => frame.id !== activeCompositionKeyframe.id),
      },
    });
  };

  const updateSubtitleRegion = (region: CompositionRegion) => {
    if (!draft) return;
    const fontSize = Math.max(14, Math.min(42, Math.round(10 + region.height * 0.9)));
    updateDraftLive({
      ...draft,
      subtitleStyle: { ...draft.subtitleStyle, region, fontSize, alignment: 'center' },
    });
  };

  const handleAutoDetectCamera = async () => {
    if (!draft || !activeComposition) return;
    setIsDetectingCamera(true);
    const fallbackCamera = { x: 2, y: 57, width: 28, height: 40 };
    try {
      const FaceDetectorCtor = (window as unknown as {
        FaceDetector?: new (options?: { fastMode?: boolean; maxDetectedFaces?: number }) => {
          detect: (source: CanvasImageSource) => Promise<Array<{ boundingBox: DOMRectReadOnly }>>;
        };
      }).FaceDetector;
      const video = videoRef.current;
      if (!FaceDetectorCtor || !video || video.readyState < 2 || !video.videoWidth) {
        updateComposition({ focus: 'auto', cameraEnabled: true, camera: fallbackCamera });
        setFeedback({ type: 'ok', text: 'Streamer camera preset applied. Adjust the magenta region if needed.' });
        return;
      }
      const detector = new FaceDetectorCtor({ fastMode: true, maxDetectedFaces: 6 });
      const faces = await detector.detect(video);
      if (faces.length === 0) {
        updateComposition({ focus: 'auto', cameraEnabled: true, camera: fallbackCamera });
        setFeedback({ type: 'ok', text: 'No face found in this frame; streamer preset applied.' });
        return;
      }
      // A facecam is usually a compact face region; prefer the face closest to a frame corner.
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const face = [...faces].sort((a, b) => {
        const cornerScore = (box: DOMRectReadOnly) => {
          const cx = (box.x + box.width / 2) / vw;
          const cy = (box.y + box.height / 2) / vh;
          return Math.min(cx, 1 - cx) + Math.min(cy, 1 - cy);
        };
        return cornerScore(a.boundingBox) - cornerScore(b.boundingBox);
      })[0].boundingBox;
      const marginX = face.width * 1.7;
      const marginY = face.height * 1.25;
      const x = Math.max(0, face.x - marginX);
      const y = Math.max(0, face.y - marginY);
      const right = Math.min(vw, face.x + face.width + marginX);
      const bottom = Math.min(vh, face.y + face.height + marginY);
      updateComposition({
        focus: 'camera',
        cameraEnabled: true,
        camera: {
          x: (x / vw) * 100,
          y: (y / vh) * 100,
          width: ((right - x) / vw) * 100,
          height: ((bottom - y) / vh) * 100,
        },
      });
      setFeedback({ type: 'ok', text: 'Facecam detected. Review the magenta region before exporting.' });
    } catch {
      updateComposition({ focus: 'auto', cameraEnabled: true, camera: fallbackCamera });
      setFeedback({ type: 'ok', text: 'Camera detection was unavailable; streamer preset applied.' });
    } finally {
      setIsDetectingCamera(false);
    }
  };

  const handleVideoError = () => {
    setIsPlaying(false);
    setIsFallbackLoading(false);
    if (previewSource === 'live' && activeVideo) {
      if (!isUsingWindowedLive) {
        setFallbackMode('mp4');
        setIsFallbackLoading(true);
        return;
      }
      if (fallbackMode !== 'webm') {
        setFallbackMode('webm');
        setIsFallbackLoading(true);
        return;
      }
    }
    setMediaError(t.mediaPlaybackError);
  };

  const handleVideoLoadedMetadata = () => {
    setIsFallbackLoading(false);
    setMediaError(null);
    const el = videoRef.current;
    if (!el) return;
    if (previewSource === 'compiled') {
      el.currentTime = 0;
      setCurrentTime(0);
      return;
    }
    if (draft) {
      const requestedAbs = pendingSeekRef.current ?? draft.startTime;
      pendingSeekRef.current = null;
      const localTarget = Math.max(0, requestedAbs - windowOffset);
      const bounded = Math.min(el.duration || Math.max(1, localTarget), localTarget);
      if (Math.abs(el.currentTime - bounded) > 0.35) {
        el.currentTime = bounded;
      }
      setCurrentTime(windowOffset + bounded);
      if (resumeTimelinePlaybackRef.current) {
        resumeTimelinePlaybackRef.current = false;
        void el.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
      }
    }
  };

  const handleTimeUpdate = () => {
    const el = videoRef.current;
    if (!el) return;
    if (previewSource === 'compiled') {
      setCurrentTime(el.currentTime);
      return;
    }
    const absSec = windowOffset + el.currentTime;
    setCurrentTime(absSec);
    if (draft && isPlaying) {
      const timeline = getTimelineSegments(draft);
      const index = Math.min(timeline.length - 1, timelinePlaybackIndexRef.current);
      const active = timeline[index];
      if (absSec >= active.end - 0.015) {
        const nextIndex = index + 1;
        if (nextIndex >= timeline.length) {
          el.pause();
          setIsPlaying(false);
          timelinePlaybackIndexRef.current = 0;
          seekTo(timeline[0].start);
        } else {
          timelinePlaybackIndexRef.current = nextIndex;
          const nextTime = timeline[nextIndex].start;
          if (isUsingWindowedLive && (nextTime < liveWindow.start || nextTime > liveWindow.end)) {
            resumeTimelinePlaybackRef.current = true;
          }
          seekTo(nextTime);
        }
      }
    }
  };

  const togglePlay = () => {
    const el = videoRef.current;
    if (!el || !resolvedVideoSrc || mediaError) return;
    if (el.paused) {
      if (previewSource === 'live' && el.readyState >= 1 && draft) {
        const absSec = windowOffset + el.currentTime;
        const timeline = getTimelineSegments(draft);
        const index = timeline.findIndex((segment) => absSec >= segment.start && absSec < segment.end);
        timelinePlaybackIndexRef.current = index >= 0 ? index : 0;
        if (index < 0) {
          el.currentTime = Math.max(0, timeline[0].start - windowOffset);
        }
      }
      try {
        const playPromise = el.play();
        if (playPromise !== undefined) {
          playPromise
            .then(() => {
              setIsPlaying(true);
              setMediaError(null);
            })
            .catch((err: unknown) => {
              setIsPlaying(false);
              if (err instanceof DOMException && err.name === 'AbortError') return;
              handleVideoError();
            });
        } else {
          setIsPlaying(true);
        }
      } catch {
        setIsPlaying(false);
        handleVideoError();
      }
    } else {
      el.pause();
      setIsPlaying(false);
    }
  };

  const seekTo = (sec: number) => {
    const el = videoRef.current;
    if (!el || !activeVideo) return;
    if (previewSource === 'compiled') {
      const clipDur = draft ? Math.max(1, draft.endTime - draft.startTime) : 1;
      const clamped = Math.max(0, Math.min(clipDur, sec));
      setCurrentTime(clamped);
      if (el.readyState >= 1) {
        el.currentTime = clamped;
      }
      return;
    }
    const clamped = Math.max(0, Math.min(activeVideo.duration, sec));
    setCurrentTime(clamped);
    if (isUsingWindowedLive && (clamped < liveWindow.start || clamped > liveWindow.end)) {
      pendingSeekRef.current = clamped;
      setLiveWindow(
        computeWindowForRange(
          clamped,
          Math.min(activeVideo.duration, clamped + 25),
          activeVideo.duration
        )
      );
      return;
    }
    if (el.readyState >= 1) {
      el.currentTime = Math.max(0, clamped - windowOffset);
    }
  };

  const activeSegment = useMemo(() => {
    const sec = previewSource === 'compiled' && draft ? draft.startTime + currentTime : currentTime;
    return segmentsDraft.find((seg) => sec >= seg.start && sec <= seg.end) ?? null;
  }, [segmentsDraft, currentTime, previewSource, draft]);

  useEffect(() => {
    const drawPreviewFrame = () => {
      const canvas = compositionCanvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video || !activeComposition || video.readyState < 2) return;

      const isVertical = activeVariant === 'vertical';
      const width = isVertical ? 360 : 640;
      const height = isVertical ? 640 : 360;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    const drawRegion = (
      region: CompositionRegion,
      dx: number,
      dy: number,
      dw: number,
      dh: number
    ) => {
      const sx = (region.x / 100) * video.videoWidth;
      const sy = (region.y / 100) * video.videoHeight;
      const sw = (region.width / 100) * video.videoWidth;
      const sh = (region.height / 100) * video.videoHeight;
      if (sw > 0 && sh > 0) ctx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
    };

    if (!activeComposition.cameraEnabled) {
      drawRegion(activeComposition.content, 0, 0, width, height);
    } else if (activeComposition.layout === 'stacked') {
      const cameraHeight = Math.round(height * activeComposition.cameraScale / 100);
      const contentHeight = height - cameraHeight;
      if (activeComposition.cameraPosition === 'top') {
        drawRegion(activeComposition.camera, 0, 0, width, cameraHeight);
        drawRegion(activeComposition.content, 0, cameraHeight, width, contentHeight);
      } else {
        drawRegion(activeComposition.content, 0, 0, width, contentHeight);
        drawRegion(activeComposition.camera, 0, contentHeight, width, cameraHeight);
      }
    } else if (activeComposition.layout === 'picture-in-picture') {
      drawRegion(activeComposition.content, 0, 0, width, height);
      const pipWidth = Math.round(width * activeComposition.cameraScale / 100);
      const pipHeight = Math.round(pipWidth * 9 / 16);
      const margin = Math.round(width * 0.04);
      const pipY = activeComposition.cameraPosition === 'top' ? margin : height - pipHeight - margin;
      drawRegion(activeComposition.camera, margin, pipY, pipWidth, pipHeight);
      ctx.strokeStyle = '#e879f9';
      ctx.lineWidth = 3;
      ctx.strokeRect(margin, pipY, pipWidth, pipHeight);
    } else {
      drawRegion(
        activeComposition.focus === 'camera' ? activeComposition.camera : activeComposition.content,
        0,
        0,
        width,
        height
      );
    }

    const frameTime = previewSource === 'live'
      ? windowOffset + video.currentTime
      : (draft?.startTime ?? 0) + video.currentTime;
    const frameSegment = segmentsDraft.find((segment) => frameTime >= segment.start && frameTime <= segment.end);
    if (draft?.subtitleStyle.enabled && frameSegment?.text) {
      const text = frameSegment.text.trim();
      const region = draft.subtitleStyle.region ?? { x: 8, y: 72, width: 84, height: 20 };
      const fontSize = Math.max(14, Math.round((draft.subtitleStyle.fontSize || 22) * (width / 420)));
      ctx.font = `700 ${fontSize}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const maxWidth = width * (region.width / 100) * 0.92;
      const words = text.split(/\s+/);
      const lines: Array<Array<{ text: string; index: number }>> = [];
      let line: Array<{ text: string; index: number }> = [];
      words.forEach((word, index) => {
        const candidate = [...line, { text: word, index }];
        if (ctx.measureText(candidate.map((item) => item.text).join(' ')).width > maxWidth && line.length) {
          lines.push(line);
          line = [{ text: word, index }];
        } else line = candidate;
      });
      if (line.length) lines.push(line);
      const visibleLines = lines.slice(0, 3);
      const segmentDuration = Math.max(0.1, frameSegment.end - frameSegment.start);
      const segmentProgress = Math.min(0.999, Math.max(0, (frameTime - frameSegment.start) / segmentDuration));
      const activeWordIndex = Math.min(words.length - 1, Math.floor(segmentProgress * words.length));
      const blockHeight = Math.min(
        height * (region.height / 100),
        visibleLines.length * fontSize * 1.2 + 20
      );
      const centerX = width * ((region.x + region.width / 2) / 100);
      const centerY = height * ((region.y + region.height / 2) / 100);
      if (draft.subtitleStyle.backgroundBox) {
        ctx.fillStyle = 'rgba(0,0,0,.72)';
        ctx.fillRect(
          width * (region.x / 100),
          centerY - blockHeight / 2,
          width * (region.width / 100),
          blockHeight
        );
      }
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 5;
      ctx.textAlign = 'left';
      visibleLines.forEach((value, index) => {
        const y = centerY + (index - (visibleLines.length - 1) / 2) * fontSize * 1.2;
        const lineWidth = ctx.measureText(value.map((item) => item.text).join(' ')).width;
        let x = centerX - lineWidth / 2;
        value.forEach((item, wordPosition) => {
          const rendered = `${item.text}${wordPosition < value.length - 1 ? ' ' : ''}`;
          ctx.strokeText(rendered, x, y);
          ctx.fillStyle = item.index === activeWordIndex
            ? draft.subtitleStyle.highlightColor
            : draft.subtitleStyle.textColor;
          ctx.fillText(rendered, x, y);
          x += ctx.measureText(rendered).width;
        });
      });
      ctx.textAlign = 'center';
    }
    };

    previewDrawRef.current = drawPreviewFrame;
    drawPreviewFrame();
  }, [activeComposition, activeVariant, currentTime, draft?.subtitleStyle, draft?.startTime, previewSource, segmentsDraft, windowOffset]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || previewSource !== 'live') return;
    const frameVideo = video as unknown as {
      requestVideoFrameCallback?: (callback: () => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    const requestVideoFrame = frameVideo.requestVideoFrameCallback?.bind(video);
    const cancelVideoFrame = frameVideo.cancelVideoFrameCallback?.bind(video);
    let stopped = false;
    let handle = 0;
    const drawNextFrame = () => {
      if (stopped) return;
      previewDrawRef.current();
      if (requestVideoFrame) {
        handle = requestVideoFrame(drawNextFrame);
      } else {
        handle = requestAnimationFrame(drawNextFrame);
      }
    };
    drawNextFrame();
    return () => {
      stopped = true;
      if (cancelVideoFrame && requestVideoFrame) {
        cancelVideoFrame(handle);
      } else cancelAnimationFrame(handle);
    };
  }, [resolvedVideoSrc, previewSource, compositionView]);

  const handleSaveDraft = async () => {
    if (!draft) return;
    setIsSaving(true);
    setFeedback(null);
    try {
      const updated = await onUpdateClip(draft.id, {
        title: draft.title,
        startTime: draft.startTime,
        endTime: draft.endTime,
        timelineSegments: getTimelineSegments(draft),
        status: draft.status,
        aspectRatio: draft.aspectRatio,
        framingMode: draft.framingMode,
        cropX: draft.cropX,
        cropY: draft.cropY,
        zoom: draft.zoom,
        compositions: ensureClipCompositions(draft),
        compositionKeyframes: draft.compositionKeyframes,
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
    if (!draft) return false;
    setIsCompiling(true);
    setFeedback(null);
    try {
      await onUpdateClip(draft.id, {
        title: draft.title,
        startTime: draft.startTime,
        endTime: draft.endTime,
        timelineSegments: getTimelineSegments(draft),
        aspectRatio: draft.aspectRatio,
        framingMode: draft.framingMode,
        cropX: draft.cropX,
        cropY: draft.cropY,
        zoom: draft.zoom,
        compositions: ensureClipCompositions(draft),
        compositionKeyframes: draft.compositionKeyframes,
        subtitleStyle: draft.subtitleStyle,
      });
      const compiled = await onCompileClip(draft.id, activeVariant);
      setDraft(compiled);
      setHasLiveEdits(false);
      setPreviewSource('compiled');
      setCurrentTime(0);
      setFeedback({
        type: 'ok',
        text: `${t.compiledReady} (${activeVariant === 'vertical' ? '9:16' : '16:9'} · ${formatBytes(compiled.exportVariants?.[activeVariant]?.exportedSizeBytes ?? compiled.exportedSizeBytes ?? 0)})`,
      });
      return true;
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Compilation failed',
      });
      return false;
    } finally {
      setIsCompiling(false);
    }
  };

  const handleShowFinalResult = async () => {
    if (!draft || isCompiling) return;
    setCompositionView('preview');
    const hasCurrentExport = Boolean(
      draft.exportVariants?.[activeVariant]?.exportedUrl ||
        (activeVariant === 'vertical' && draft.exportedUrl)
    );
    if (hasLiveEdits || !hasCurrentExport) {
      await handleCompile();
      return;
    }
    setPreviewSource('compiled');
    setCurrentTime(0);
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

  const handleImportSrtFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !activeVideo) return;
    setIsSaving(true);
    setFeedback(null);
    try {
      const result = await onImportSrt(activeVideo.id, file);
      setFeedback({
        type: 'ok',
        text: `${t.msgSrtImported}: ${result.importedCount} (${file.name})`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Failed to import SRT file',
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

  const clipDuration = draft
    ? Math.max(0.1, getTimelineSegments(draft).reduce((sum, segment) => sum + segment.end - segment.start, 0))
    : 0;

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
                      <span className="flex items-center gap-1.5">
                        {clip.exportedUrl && (
                          <span className="font-mono text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                            MP4
                          </span>
                        )}
                        <span>{t.statusLabels[clip.status]}</span>
                      </span>
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
                    {(['vertical', 'horizontal'] as CompositionVariant[]).map((variant) => (
                      <button
                        key={variant}
                        type="button"
                        onClick={() => {
                          setActiveVariant(variant);
                          setCompositionView('edit');
                          const composition = getClipComposition(draft, variant);
                          setDraft({ ...draft, aspectRatio: composition.aspectRatio });
                          const hasExport = Boolean(
                            draft.exportVariants?.[variant]?.exportedUrl ||
                              (variant === 'vertical' && draft.exportedUrl)
                          );
                          setPreviewSource(hasExport ? 'compiled' : 'live');
                          setCurrentTime(hasExport ? 0 : draft.startTime);
                        }}
                        className={`rounded-md px-2.5 py-1 font-mono text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                          activeVariant === variant
                            ? 'bg-white text-slate-900 shadow-sm dark:bg-[#252A36] dark:text-white'
                            : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                        }`}
                      >
                        {variant === 'vertical' ? 'Vertical 9:16' : 'Horizontal 16:9'}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-stretch gap-1 rounded-lg bg-slate-100 p-1 dark:bg-[#181B22]">
                    {(['focus', 'stacked', 'picture-in-picture'] as const).map((layout) => (
                      <button
                        key={layout}
                        type="button"
                        onClick={() => {
                          updateComposition({
                            layout,
                            focus: layout === 'focus' ? 'content' : 'split',
                            cameraEnabled: layout !== 'focus',
                          });
                          setFeedback({
                            type: 'ok',
                            text: layout === 'focus'
                              ? 'Una zona ocupará todo el clip.'
                              : layout === 'stacked'
                              ? 'Cámara y contenido aparecerán uno sobre otro.'
                              : 'La cámara aparecerá flotando sobre el contenido.',
                          });
                        }}
                        title={layout === 'focus'
                          ? 'Una sola región llena todo el formato'
                          : layout === 'stacked'
                          ? 'Cámara y contenido divididos verticalmente'
                          : 'Cámara pequeña encima del contenido'}
                        className={`flex flex-col rounded-md px-2.5 py-1 text-left text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                          activeComposition?.layout === layout
                            ? 'bg-white text-slate-900 shadow-sm dark:bg-[#252A36] dark:text-white'
                            : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                        }`}
                      >
                        <span className="font-semibold">
                          {layout === 'focus' ? 'Original / una zona' : layout === 'stacked' ? 'Apilado' : 'Cámara flotante'}
                        </span>
                        <span className="text-[9px] opacity-65">
                          {layout === 'focus' ? 'Llena la pantalla' : layout === 'stacked' ? 'Dos bloques' : 'Sobre el contenido'}
                        </span>
                      </button>
                    ))}
                  </div>

                  {activeComposition?.layout === 'focus' && (
                    <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-[#181B22]">
                      {(['content', 'camera'] as const).map((focus) => (
                        <button key={focus} type="button" onClick={() => updateComposition({
                          focus,
                          cameraEnabled: focus === 'camera',
                        })}
                          className={`rounded-md px-2 py-1 text-[11px] font-medium ${
                            activeComposition.focus === focus
                              ? 'bg-white text-slate-900 shadow-sm dark:bg-[#252A36] dark:text-white'
                              : 'text-slate-500 dark:text-slate-400'
                          }`}>
                          {focus === 'content' ? 'Usar contenido' : 'Usar cámara'}
                        </button>
                      ))}
                    </div>
                  )}

                  {activeComposition && activeComposition.layout !== 'focus' && (
                    <button type="button"
                      onClick={() => updateComposition({
                        cameraPosition: activeComposition.cameraPosition === 'top' ? 'bottom' : 'top',
                      })}
                      className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-medium text-slate-600 dark:border-white/10 dark:text-slate-300">
                      Cámara {activeComposition.cameraPosition === 'top' ? 'arriba' : 'abajo'} · cambiar
                    </button>
                  )}
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

              {(feedback || activeVariantExport?.exportedUrl || (activeVariant === 'vertical' && draft.exportedUrl) || hasLiveEdits) && (
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
                    {!feedback && hasLiveEdits && (
                      <span className="text-amber-600 dark:text-amber-400">
                        {t.pendingRecompile}
                      </span>
                    )}
                    {!feedback && !hasLiveEdits && (activeVariantExport?.exportedUrl || (activeVariant === 'vertical' && draft.exportedUrl)) && (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {t.compiledReady} ({formatBytes(draft.exportedSizeBytes ?? 0)})
                      </span>
                    )}
                  </div>

                  {(activeVariantExport?.exportedUrl || (activeVariant === 'vertical' && draft.exportedUrl)) && (
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1 rounded-md bg-slate-200/70 p-0.5 dark:bg-[#181B22]">
                        <button
                          type="button"
                          onClick={() => {
                            setPreviewSource('live');
                            if (draft) setCurrentTime(draft.startTime);
                          }}
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
                          onClick={() => {
                            setPreviewSource('compiled');
                            setCurrentTime(0);
                          }}
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
                        href={`/api/clips/${draft.id}/download?format=mp4&variant=${activeVariant}`}
                        className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-2.5 py-1 text-[11px] font-semibold text-slate-950 hover:bg-emerald-400"
                      >
                        <Download className="h-3 w-3" />
                        <span>MP4</span>
                      </a>
                      {draft.srtUrl && (
                        <a
                          href={`/api/clips/${draft.id}/download?format=srt&variant=${activeVariant}`}
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
              <div className="relative flex min-h-0 flex-1 flex-col items-center justify-start gap-3 overflow-x-hidden overflow-y-auto bg-slate-950 p-4">
                {previewSource === 'live' && (
                  <div className="sticky top-0 z-30 flex w-full shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-slate-950/95 pb-3 text-[11px] text-slate-300 backdrop-blur">
                    <span>
                      {isSubtitleEditing
                        ? 'Arrastra y redimensiona el cuadro de subtítulos directamente sobre el video.'
                        : compositionView === 'edit'
                        ? 'Arrastra las cajas sobre el video original. Usa la esquina para cambiar su tamaño.'
                        : 'Previsualización final con encuadre y subtítulos.'}
                    </span>
                    <div className="flex flex-wrap justify-end gap-2">
                      <div className="flex rounded-md bg-white/10 p-0.5">
                        {(['edit', 'preview'] as const).map((view) => (
                          <button
                            key={view}
                            type="button"
                            disabled={isCompiling}
                            onClick={() => {
                              if (view === 'preview') {
                                void handleShowFinalResult();
                              } else {
                                setCompositionView('edit');
                                setPreviewSource('live');
                                setCurrentTime(draft.startTime);
                              }
                            }}
                            className={`rounded px-2.5 py-1 font-semibold ${compositionView === view ? 'bg-white text-slate-950' : 'text-slate-300'}`}>
                            {view === 'edit' ? (
                              'Editar áreas'
                            ) : isCompiling ? (
                              <span className="inline-flex items-center gap-1.5">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                Compilando…
                              </span>
                            ) : (
                              'Compilar y ver resultado'
                            )}
                          </button>
                        ))}
                      </div>
                      {!isSubtitleEditing && compositionView === 'edit' && activeComposition?.cameraEnabled && (
                        <button type="button" onClick={() => updateComposition({ cameraEnabled: false, layout: 'focus', focus: 'content' })}
                          className="rounded-md border border-red-400/50 px-2.5 py-1 font-semibold text-red-300 hover:bg-red-400/10">
                          Eliminar cámara
                        </button>
                      )}
                      {!isSubtitleEditing && compositionView === 'edit' && (
                        <button
                          type="button"
                          onClick={handleAutoDetectCamera}
                          disabled={isDetectingCamera}
                          className="shrink-0 rounded-md border border-emerald-400/50 px-2.5 py-1 font-semibold text-emerald-300 hover:bg-emerald-400/10 disabled:opacity-50"
                        >
                          {isDetectingCamera ? 'Detectando…' : activeComposition?.cameraEnabled ? 'Volver a detectar' : 'Añadir cámara'}
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {isCompiling && compositionView === 'preview' && (
                  <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/85 backdrop-blur-sm">
                    <div className="flex flex-col items-center gap-3 rounded-xl border border-white/10 bg-black/50 px-6 py-5 text-center text-slate-100 shadow-2xl">
                      <Loader2 className="h-8 w-8 animate-spin text-emerald-400" />
                      <div>
                        <div className="text-sm font-semibold">Compilando resultado final</div>
                        <div className="mt-1 text-xs text-slate-400">Aplicando encuadre, cámara y subtítulos al MP4…</div>
                      </div>
                    </div>
                  </div>
                )}
                <div className={`grid w-full shrink-0 items-center gap-4 ${previewSource === 'live' && compositionView === 'edit' && !isSubtitleEditing ? 'lg:grid-cols-[minmax(0,1fr)_210px]' : 'place-items-center'}`}>
                <div
                  data-focus-canvas
                  style={isSubtitleWorkspace && previewSource === 'compiled'
                    ? { maxWidth: activeVariant === 'vertical' ? 230 : 680 }
                    : undefined}
                  className={`relative overflow-hidden rounded-lg border border-white/15 bg-black shadow-2xl ${
                    (previewSource === 'live' && compositionView === 'preview') || isSubtitleEditing
                      ? 'absolute h-px w-px overflow-hidden opacity-0 pointer-events-none'
                      : previewSource === 'live'
                      ? 'aspect-video w-full'
                      : draft.aspectRatio === '9:16'
                      ? 'aspect-[9/16] h-full max-h-[430px]'
                      : draft.aspectRatio === '1:1'
                      ? 'aspect-square h-full max-h-[410px]'
                      : 'aspect-video w-full max-w-[680px]'
                  }`}
                >
                  {resolvedVideoSrc && !mediaError ? (
                    <video
                      ref={videoRef}
                      key={resolvedVideoSrc}
                      src={resolvedVideoSrc}
                      preload={previewSource === 'compiled' || isUsingWindowedLive ? 'auto' : 'metadata'}
                      muted={isMuted}
                      playsInline
                      onLoadStart={() => {
                        if (isUsingWindowedLive) setIsFallbackLoading(true);
                      }}
                      onLoadedMetadata={handleVideoLoadedMetadata}
                      onCanPlay={() => setIsFallbackLoading(false)}
                      onPlay={() => setIsPlaying(true)}
                      onPause={() => setIsPlaying(false)}
                      onError={handleVideoError}
                      onTimeUpdate={handleTimeUpdate}
                      onEnded={() => setIsPlaying(false)}
                      onClick={togglePlay}
                      className="h-full w-full cursor-pointer"
                      style={{ objectFit: 'contain' }}
                    />
                  ) : (
                    <div className="relative flex h-full w-full flex-col items-center justify-center bg-slate-900 p-4 text-center">
                      {activeVideo.thumbnailUrl && (
                        <img
                          src={activeVideo.thumbnailUrl}
                          alt={activeVideo.title}
                          referrerPolicy="no-referrer"
                          className="absolute inset-0 h-full w-full object-cover opacity-35"
                        />
                      )}
                      <div className="relative z-10 max-w-xs space-y-2 rounded-lg border border-white/15 bg-black/75 p-3">
                        <Film className="mx-auto h-6 w-6 text-emerald-400" />
                        <p className="text-xs leading-relaxed text-slate-200">
                          {mediaError || t.mediaPlaybackError}
                        </p>
                      </div>
                    </div>
                  )}

                  {previewSource === 'live' && compositionView === 'edit' && activeComposition && !mediaError && (
                    <div className="absolute inset-0">
                      <FocusRegionBox
                        label="CONTENIDO"
                        color="cyan"
                        region={activeComposition.content}
                        onChange={(content) => updateComposition({ content })}
                      />
                      {activeComposition.cameraEnabled && (
                        <FocusRegionBox
                          label="CÁMARA"
                          color="fuchsia"
                          region={activeComposition.camera}
                          onChange={(camera) => updateComposition({ camera })}
                        />
                      )}
                    </div>
                  )}

                  {isFallbackLoading && !mediaError && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60 p-4">
                      <div className="flex items-center gap-2 rounded-md bg-black/80 px-3 py-2 text-xs text-slate-200">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" />
                        <span>{t.loadingFallbackPreview}</span>
                      </div>
                    </div>
                  )}
                </div>
                {/* Preview Result */}
                {previewSource === 'live' && (
                  <div className={`flex flex-col items-center gap-2 ${
                    compositionView === 'preview'
                      ? activeVariant === 'vertical' ? 'w-full max-w-[320px]' : 'w-full max-w-[760px]'
                      : 'w-full'
                  }`}>
                    <div className="text-center text-[11px] font-semibold text-slate-200">
                      Resultado {activeVariant === 'vertical' ? 'vertical 9:16' : 'horizontal 16:9'}
                    </div>
                    <div
                      data-focus-canvas
                      className={`relative w-full overflow-hidden rounded-lg ${
                      compositionView === 'preview'
                        ? 'max-h-[500px] max-w-[720px]'
                        : isSubtitleEditing
                        ? activeVariant === 'vertical'
                          ? 'max-h-[302px] max-w-[170px]'
                          : 'max-w-[520px]'
                        : 'max-h-[390px]'
                    } ${activeVariant === 'vertical' ? 'aspect-[9/16]' : 'aspect-video'}`}>
                      <canvas
                        ref={compositionCanvasRef}
                        className="block h-full w-full border border-white/15 bg-black shadow-xl"
                      />
                      {inspectorTab === 'subtitles' && draft.subtitleStyle.enabled && compositionView === 'edit' && (
                        <FocusRegionBox
                          label="SUBTÍTULOS"
                          color="emerald"
                          region={subtitleRegion}
                          onChange={updateSubtitleRegion}
                        />
                      )}
                    </div>
                    <div className="text-center text-[10px] leading-relaxed text-slate-400">
                      Esta vista incluye encuadre y subtítulos antes de exportar.
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
                      onClick={() => seekTo(previewSource === 'compiled' ? 0 : draft.startTime)}
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
                      {previewSource === 'compiled'
                        ? `${formatTimecode(currentTime, true)} / ${formatTimecode(clipDuration, true)}`
                        : `${formatTimecode(currentTime, true)} / ${formatTimecode(activeVideo.duration, true)}`}
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
                    seekTo(pct * (previewSource === 'compiled' ? clipDuration : activeVideo.duration));
                  }}
                >
                  {previewSource === 'compiled' ? (
                    <>
                      <div
                        className="absolute inset-y-1 left-0 rounded bg-emerald-500/25 border-r-2 border-emerald-500"
                        style={{
                          width: `${Math.min(100, (currentTime / Math.max(1, clipDuration)) * 100)}%`,
                        }}
                      />
                    </>
                  ) : (
                    <>
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
                    </>
                  )}
                </div>

                {previewSource === 'live' && (
                  <div className="space-y-2 rounded-lg border border-slate-200 p-2.5 dark:border-white/10">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">Timeline de edición</div>
                        <div className="text-[10px] text-slate-500">Mueve el cabezal y corta. Arrastra los fragmentos para cambiar su orden.</div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button type="button" onClick={addCompositionKeyframe}
                          className="inline-flex items-center gap-1 rounded-md border border-violet-500/40 bg-violet-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-violet-700 hover:bg-violet-500/20 dark:text-violet-300">
                          <Plus className="h-3.5 w-3.5" /> Cambio de cámara
                        </button>
                        {activeCompositionKeyframe && (
                          <button type="button" onClick={removeActiveCompositionKeyframe} title="Eliminar keyframe activo"
                            className="rounded-md border border-violet-500/30 p-1.5 text-violet-600 hover:bg-violet-500/10 dark:text-violet-300">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <button type="button" onClick={splitTimelineAtPlayhead}
                          className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-2.5 py-1.5 text-[11px] font-semibold text-slate-950 hover:bg-emerald-400">
                          <Scissors className="h-3.5 w-3.5" /> Cortar
                        </button>
                        {timelineUndoSegments && (
                          <button type="button" onClick={undoTimelineEdit}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1.5 text-[11px] font-medium hover:bg-slate-100 dark:border-white/15 dark:hover:bg-white/5">
                            <RotateCcw className="h-3.5 w-3.5" /> Deshacer
                          </button>
                        )}
                      </div>
                    </div>
                    {recentSplit && (
                      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-[10px]">
                        <span className="mr-auto font-semibold">Corte creado. ¿Qué parte quieres eliminar?</span>
                        <button type="button" onClick={() => deleteTimelineSegment(recentSplit.leftId)}
                          className="rounded border border-red-500/30 px-2 py-1 text-red-600 hover:bg-red-500/10 dark:text-red-400">Eliminar inicio</button>
                        <button type="button" onClick={() => deleteTimelineSegment(recentSplit.rightId)}
                          className="rounded border border-red-500/30 px-2 py-1 text-red-600 hover:bg-red-500/10 dark:text-red-400">Eliminar final</button>
                        <button type="button" onClick={() => setRecentSplit(null)}
                          className="rounded border border-slate-300 px-2 py-1 hover:bg-white/60 dark:border-white/15 dark:hover:bg-white/10">Conservar ambas</button>
                      </div>
                    )}
                    {variantKeyframes.length > 0 && <div className="space-y-1">
                      <div className="flex items-center justify-between text-[10px] text-slate-500">
                        <span>Composición · {activeVariant === 'vertical' ? 'Vertical 9:16' : 'Horizontal 16:9'}</span>
                        <span>{variantKeyframes.length} cambios</span>
                      </div>
                      <div className="relative h-7 overflow-hidden rounded-md bg-violet-500/10 ring-1 ring-inset ring-violet-500/20"
                        onClick={(event) => {
                          const rect = event.currentTarget.getBoundingClientRect();
                          seekToEditedTime(((event.clientX - rect.left) / rect.width) * editedTimelineDuration);
                        }}>
                        <div className="absolute inset-y-0 w-0.5 bg-white shadow"
                          style={{ left: `${Math.min(100, Math.max(0, logicalPlayheadTime / Math.max(0.1, editedTimelineDuration) * 100))}%` }} />
                        {variantKeyframes.map((frame) => (
                          <button key={frame.id} type="button" title={`Keyframe ${formatTimecode(frame.time, true)}`}
                            onClick={(event) => { event.stopPropagation(); seekToEditedTime(frame.time); }}
                            className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border ${activeCompositionKeyframe?.id === frame.id ? 'border-white bg-violet-400' : 'border-violet-300 bg-violet-600'}`}
                            style={{ left: `${frame.time / Math.max(0.1, editedTimelineDuration) * 100}%` }} />
                        ))}
                      </div>
                    </div>}
                    <div className="flex min-h-12 gap-1.5 overflow-x-auto pb-1">
                      {getTimelineSegments(draft).map((segment, index) => {
                        const selected = selectedTimelineSegmentId === segment.id;
                        return (
                          <div key={segment.id} draggable
                            onDragStart={() => setDraggedTimelineSegmentId(segment.id)}
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={() => reorderTimelineSegment(segment.id)}
                            onClick={() => { setSelectedTimelineSegmentId(segment.id); seekTo(segment.start); }}
                            style={{ flexGrow: Math.max(1, segment.end - segment.start) }}
                            className={`relative min-w-32 cursor-grab rounded-md border-2 p-2 transition-colors active:cursor-grabbing ${selected ? 'border-amber-400 bg-amber-400/15 shadow-sm shadow-amber-500/20' : 'border-slate-200 bg-slate-50 hover:border-emerald-500/50 dark:border-white/10 dark:bg-white/[0.03]'}`}>
                            <div className="flex items-center justify-between text-[10px]">
                              <span className="font-semibold">{selected ? '✓ ' : ''}Fragmento {index + 1}</span>
                              <div className="flex items-center gap-1">
                                <span className="font-mono">{(segment.end - segment.start).toFixed(2)}s</span>
                                <button type="button" aria-label={`Opciones del fragmento ${index + 1}`}
                                  onClick={(event) => { event.stopPropagation(); setSelectedTimelineSegmentId(segment.id); setTimelineMenuSegmentId((value) => value === segment.id ? null : segment.id); }}
                                  className="rounded p-0.5 hover:bg-black/10 dark:hover:bg-white/10">
                                  <MoreHorizontal className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                            <div className="mt-1 font-mono text-[10px] text-slate-500">
                              {formatTimecode(segment.start, true)} → {formatTimecode(segment.end, true)}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {timelineMenuSegmentId && (() => {
                      const segments = getTimelineSegments(draft);
                      const index = segments.findIndex((segment) => segment.id === timelineMenuSegmentId);
                      const segment = segments[index];
                      if (!segment) return null;
                      return (
                        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-amber-400/40 bg-amber-400/10 p-2 text-[10px]">
                          <span className="mr-auto font-semibold">Fragmento {index + 1} seleccionado</span>
                          <button type="button" onClick={() => deleteTimelineSegment(segment.id)}
                            className="inline-flex items-center gap-1 rounded bg-red-500 px-2 py-1 font-semibold text-white hover:bg-red-600">
                            <Trash2 className="h-3 w-3" /> Eliminar fragmento
                          </button>
                          <button type="button" onClick={() => setTimelineMenuSegmentId(null)} className="rounded p-1 hover:bg-black/10 dark:hover:bg-white/10" aria-label="Cerrar opciones"><X className="h-3 w-3" /></button>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {previewSource !== 'live' && <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-2">
                  <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-1.5 dark:border-white/10">
                    <span className="text-xs font-medium text-slate-500 dark:text-slate-400 shrink-0">
                      {t.start}
                    </span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() =>
                          updateDraftLive({
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
                          updateDraftLive({
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

                  <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-1.5 dark:border-white/10">
                    <span className="text-xs font-medium text-slate-500 dark:text-slate-400 shrink-0">
                      {t.end}
                    </span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() =>
                          updateDraftLive({
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
                          updateDraftLive({
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
                </div>}
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
          {draft && activeComposition && (
            <div className="space-y-2 border-b border-slate-200 p-3 dark:border-white/10">
              <div className="text-xs font-semibold text-slate-900 dark:text-white">Composición del clip</div>
              <p className="text-[11px] leading-relaxed text-slate-500">
                Define Cámara y Contenido arrastrando las cajas directamente sobre el video horizontal.
              </p>
              <label className="flex items-center gap-2 text-[11px] font-medium text-slate-700 dark:text-slate-200">
                <input type="checkbox" checked={activeComposition.creditEnabled}
                  onChange={(e) => updateComposition({ creditEnabled: e.target.checked })}
                  className="accent-emerald-500" />
                Mostrar crédito del creador
              </label>
              {activeComposition.creditEnabled && (
                <input
                  type="text"
                  value={activeComposition.creditText}
                  onChange={(e) => updateComposition({ creditText: e.target.value })}
                  placeholder="@creator · twitch.tv/creator"
                  className="w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs dark:border-white/10 dark:bg-[#181B22]"
                />
              )}
            </div>
          )}
          <div className="border-b border-slate-200 p-2 dark:border-white/10">
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-[#181B22]">
              {(['score', 'subtitles', 'transcript'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => {
                    setInspectorTab(tab);
                    if (tab === 'subtitles') {
                      // Subtitle positioning must happen on the editable
                      // composition canvas, not on the large compiled player.
                      setPreviewSource('live');
                      setCompositionView('edit');
                      setCurrentTime(draft?.startTime ?? 0);
                    }
                  }}
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
                      updateDraftLive({
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
                        updateDraftLive({
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

                {draft.subtitleStyle.enabled && (
                  <label className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5 text-xs text-slate-600 dark:border-white/10 dark:text-slate-300">
                    <span>
                      <span className="block font-semibold text-slate-900 dark:text-white">{t.wordHighlight}</span>
                      <span className="mt-0.5 block text-[11px] opacity-70">{t.wordHighlightHint}</span>
                    </span>
                    <input
                      type="color"
                      value={draft.subtitleStyle.highlightColor}
                      onChange={(event) =>
                        updateDraftLive({
                          ...draft,
                          subtitleStyle: {
                            ...draft.subtitleStyle,
                            highlightColor: event.target.value,
                          },
                        })
                      }
                      className="h-9 w-11 cursor-pointer rounded-md border border-slate-200 bg-transparent p-1 dark:border-white/15"
                    />
                  </label>
                )}

                {draft.subtitleStyle.enabled && (
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs leading-relaxed text-emerald-800 dark:text-emerald-200">
                    <div className="font-semibold">Coloca los subtítulos directamente en el video</div>
                    <div className="mt-1 opacity-80">
                      Arrastra la caja verde para moverlos. Usa la esquina para cambiar su tamaño.
                    </div>
                    {previewSource === 'compiled' && (
                      <button
                        type="button"
                        onClick={() => {
                          setPreviewSource('live');
                          setCompositionView('edit');
                          setCurrentTime(draft.startTime);
                        }}
                        className="mt-2 rounded-md bg-emerald-500 px-2.5 py-1 font-semibold text-slate-950"
                      >
                        Editar posición
                      </button>
                    )}
                  </div>
                )}

                <div className="hidden">
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
                        updateDraftLive({
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
                            updateDraftLive({
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
                            updateDraftLive({
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
                          updateDraftLive({
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
                          updateDraftLive({
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
                        updateDraftLive({
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

                <div className="hidden">
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
                      onChange={(e) => updateDraftLive({ ...draft, cropX: Number(e.target.value) })}
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
                      onChange={(e) => updateDraftLive({ ...draft, cropY: Number(e.target.value) })}
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
                      onChange={(e) => updateDraftLive({ ...draft, zoom: Number(e.target.value) })}
                      className="w-full accent-emerald-500"
                    />
                  </div>
                </div>
              </div>
            )}

            {inspectorTab === 'transcript' && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                    {t.syncedSegments} ({segmentsDraft.length})
                  </span>
                  <div className="flex items-center gap-1.5">
                    <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:text-slate-200 dark:hover:bg-white/5">
                      <Upload className="h-3 w-3" />
                      <span>{t.importSrt}</span>
                      <input
                        type="file"
                        accept=".srt"
                        disabled={isSaving}
                        onChange={handleImportSrtFile}
                        className="sr-only"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={isSaving || segmentsDraft.length === 0}
                      onClick={handleSaveTranscriptSegments}
                      className="rounded-md bg-emerald-500 px-2.5 py-1 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
                    >
                      {t.saveText}
                    </button>
                  </div>
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
                                    updateDraftLive({
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
                                    updateDraftLive({
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
