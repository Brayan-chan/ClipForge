import { useCallback, useEffect, useState } from 'react';
import { TopBar, type NavTab } from './components/TopBar';
import { ProjectsDashboard } from './components/ProjectsDashboard';
import { ClipStudio } from './components/ClipStudio';
import { ScoringLab } from './components/ScoringLab';
import { PipelineView } from './components/PipelineView';
import { UploadModal } from './components/UploadModal';
import type { Language } from './i18n';
import { readJsonResponse } from './utils/http';
import type {
  ClipRecord,
  ProcessingJob,
  Project,
  ScoringConfig,
  SystemStatus,
  TranscriptSegment,
  TranscriptionRecord,
  VideoRecord,
} from './types';

function getInitialLanguage(): Language {
  try {
    const saved = localStorage.getItem('clipforge_lang');
    if (saved === 'en' || saved === 'es') return saved;
    if (typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('es')) {
      return 'es';
    }
  } catch {
    // ignore storage access issues
  }
  return 'es';
}

export function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('projects');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [lang, setLang] = useState<Language>(getInitialLanguage);

  const [projects, setProjects] = useState<Project[]>([]);
  const [videos, setVideos] = useState<VideoRecord[]>([]);
  const [transcriptions, setTranscriptions] = useState<TranscriptionRecord[]>([]);
  const [clips, setClips] = useState<ClipRecord[]>([]);
  const [jobs, setJobs] = useState<ProcessingJob[]>([]);
  const [scoringConfig, setScoringConfig] = useState<ScoringConfig>({
    hookWeight: 25,
    infoWeight: 25,
    emotionWeight: 20,
    selfContainedWeight: 20,
    durationWeight: 10,
    llmThreshold: 55,
    minClipSeconds: 12,
    maxClipSeconds: 60,
  });
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);

  const [selectedVideoId, setSelectedVideoId] = useState<number | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<number | null>(null);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [trackedJobId, setTrackedJobId] = useState<number | null>(null);

  const handleChangeLang = (next: Language) => {
    setLang(next);
    try {
      localStorage.setItem('clipforge_lang', next);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const fetchWorkspace = useCallback(async () => {
    const [wsRes, statusRes] = await Promise.all([
      fetch('/api/workspace'),
      fetch('/api/status'),
    ]);
    if (wsRes.ok) {
      const ws = (await wsRes.json()) as {
        projects: Project[];
        videos: VideoRecord[];
        transcriptions: TranscriptionRecord[];
        clips: ClipRecord[];
        jobs: ProcessingJob[];
        scoringConfig: ScoringConfig;
      };
      setProjects(ws.projects);
      setVideos(ws.videos);
      setTranscriptions(ws.transcriptions);
      setClips(ws.clips);
      setJobs(ws.jobs);
      setScoringConfig(ws.scoringConfig);
    }
    if (statusRes.ok) {
      const st = (await statusRes.json()) as SystemStatus;
      setSystemStatus(st);
    }
  }, []);

  useEffect(() => {
    void fetchWorkspace();
  }, [fetchWorkspace]);

  const trackedJob =
    trackedJobId !== null ? jobs.find((j) => j.id === trackedJobId) ?? null : null;

  const isTrackedJobActive =
    trackedJobId !== null &&
    (!trackedJob ||
      (trackedJob.stage !== 'completed' &&
        trackedJob.stage !== 'failed' &&
        trackedJob.stage !== 'interrupted'));

  const hasProcessingVideos = videos.some((v) => v.status === 'processing');
  useEffect(() => {
    if (!hasProcessingVideos && !isTrackedJobActive) return;
    const timer = setInterval(() => {
      void fetchWorkspace();
    }, 1000);
    return () => clearInterval(timer);
  }, [hasProcessingVideos, isTrackedJobActive, fetchWorkspace]);

  const handleVideoCreated = (videoId: number, job: ProcessingJob) => {
    setSelectedVideoId(videoId);
    setTrackedJobId(job.id);
    setJobs((prev) => (prev.some((j) => j.id === job.id) ? prev : [...prev, job]));
    void fetchWorkspace();
  };

  const handleGenerateDemo = async () => {
    const res = await fetch('/api/videos/demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: projects[0]?.id ?? 1, useAi: false }),
    });
    if (res.ok) {
      const data = (await res.json()) as { video: VideoRecord; job: ProcessingJob };
      setSelectedVideoId(data.video.id);
      setTrackedJobId(data.job.id);
      await fetchWorkspace();
    }
  };

  const handleOpenStudio = (videoId: number, clipId?: number) => {
    setSelectedVideoId(videoId);
    if (clipId !== undefined) {
      setSelectedClipId(clipId);
    } else {
      const firstClip = clips.find((c) => c.videoId === videoId);
      setSelectedClipId(firstClip?.id ?? null);
    }
    setActiveTab('studio');
  };

  const handleDeleteVideo = async (videoId: number) => {
    const res = await fetch(`/api/videos/${videoId}`, { method: 'DELETE' });
    const result = await readJsonResponse<{ removedArtifacts: number; removedBytes: number }>(res);
    if (selectedVideoId === videoId) {
      setSelectedVideoId(null);
      setSelectedClipId(null);
    }
    await fetchWorkspace();
    return result;
  };

  const handleRetryVideo = async (videoId: number) => {
    const res = await fetch(`/api/videos/${videoId}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ useAi: false }),
    });
    if (res.ok) {
      const data = (await res.json()) as { job: ProcessingJob };
      setTrackedJobId(data.job.id);
      await fetchWorkspace();
    }
  };

  const handleUpdateClip = async (clipId: number, patch: Partial<ClipRecord>): Promise<ClipRecord> => {
    const res = await fetch(`/api/clips/${clipId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const updated = await readJsonResponse<ClipRecord>(res);
    await fetchWorkspace();
    return updated;
  };

  const handleCompileClip = async (
    clipId: number,
    variant: 'vertical' | 'horizontal' = 'vertical'
  ): Promise<ClipRecord> => {
    const res = await fetch(`/api/clips/${clipId}/compile?variant=${variant}`, { method: 'POST' });
    const data = await readJsonResponse<ClipRecord>(res);
    await fetchWorkspace();
    return data;
  };

  const handleRescoreClip = async (clipId: number, useAi: boolean): Promise<ClipRecord> => {
    const res = await fetch(`/api/clips/${clipId}/rescore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ useAi }),
    });
    const data = await readJsonResponse<ClipRecord>(res);
    await fetchWorkspace();
    return data;
  };

  const handleCreateClip = async (
    videoId: number,
    startTime: number,
    endTime: number
  ): Promise<ClipRecord> => {
    const res = await fetch('/api/clips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, startTime, endTime }),
    });
    const created = await readJsonResponse<ClipRecord>(res);
    await fetchWorkspace();
    return created;
  };

  const handleDeleteClip = async (clipId: number) => {
    await fetch(`/api/clips/${clipId}`, { method: 'DELETE' });
    if (selectedClipId === clipId) {
      setSelectedClipId(null);
    }
    await fetchWorkspace();
  };

  const handleSaveTranscript = async (videoId: number, segments: TranscriptSegment[]) => {
    const res = await fetch(`/api/transcriptions/${videoId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segments }),
    });
    await readJsonResponse(res);
    await fetchWorkspace();
  };

  const handleImportSrt = async (
    videoId: number,
    file: File
  ): Promise<{ importedCount: number }> => {
    const form = new FormData();
    form.append('srt', file);
    const res = await fetch(`/api/transcriptions/${videoId}/import-srt`, {
      method: 'POST',
      body: form,
    });
    const data = await readJsonResponse<{
      importedCount?: number;
      transcription?: TranscriptionRecord;
    }>(res);
    await fetchWorkspace();
    return { importedCount: data.importedCount ?? data.transcription?.segments?.length ?? 0 };
  };

  const handleCreateProject = async (name: string) => {
    await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await fetchWorkspace();
  };

  const handleSaveScoringConfig = async (next: ScoringConfig) => {
    await fetch('/api/scoring-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    await fetchWorkspace();
  };

  const handleCleanupStorage = async () => {
    const res = await fetch('/api/storage/cleanup', { method: 'POST' });
    const result = await readJsonResponse<{
      removedFiles: number;
      removedBytes: number;
      storageBytes: number;
    }>(res);
    await fetchWorkspace();
    return result;
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-[#0A0B0E] dark:text-slate-100">
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onOpenUpload={() => {
          setTrackedJobId(null);
          setUploadModalOpen(true);
        }}
        lang={lang}
      />

      {activeTab === 'projects' && (
        <ProjectsDashboard
          projects={projects}
          videos={videos}
          clips={clips}
          jobs={jobs}
          onOpenUpload={() => {
            setTrackedJobId(null);
            setUploadModalOpen(true);
          }}
          onGenerateDemo={handleGenerateDemo}
          onOpenStudio={handleOpenStudio}
          onDeleteVideo={handleDeleteVideo}
          onRetryVideo={handleRetryVideo}
          onCompileClip={async (id) => {
            await handleCompileClip(id);
          }}
          onCreateProject={handleCreateProject}
          lang={lang}
          onChangeLang={handleChangeLang}
        />
      )}

      {activeTab === 'studio' && (
        <ClipStudio
          videos={videos}
          clips={clips}
          transcriptions={transcriptions}
          scoringConfig={scoringConfig}
          geminiConfigured={systemStatus?.geminiConfigured ?? false}
          selectedVideoId={selectedVideoId}
          selectedClipId={selectedClipId}
          onSelectVideo={(id) => {
            setSelectedVideoId(id);
            const firstClip = clips.find((c) => c.videoId === id);
            setSelectedClipId(firstClip?.id ?? null);
          }}
          onSelectClip={setSelectedClipId}
          onUpdateClip={handleUpdateClip}
          onCompileClip={handleCompileClip}
          onRescoreClip={handleRescoreClip}
          onCreateClip={handleCreateClip}
          onDeleteClip={handleDeleteClip}
          onSaveTranscript={handleSaveTranscript}
          onImportSrt={handleImportSrt}
          onOpenUpload={() => {
            setTrackedJobId(null);
            setUploadModalOpen(true);
          }}
          lang={lang}
          onChangeLang={handleChangeLang}
        />
      )}

      {activeTab === 'scoring' && (
        <ScoringLab
          config={scoringConfig}
          onSaveConfig={handleSaveScoringConfig}
          lang={lang}
          onChangeLang={handleChangeLang}
        />
      )}

      {activeTab === 'pipeline' && (
        <PipelineView
          status={systemStatus}
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          onCleanupStorage={handleCleanupStorage}
          lang={lang}
          onChangeLang={handleChangeLang}
        />
      )}

      <UploadModal
        isOpen={uploadModalOpen}
        onClose={() => setUploadModalOpen(false)}
        projects={projects}
        clips={clips}
        geminiConfigured={systemStatus?.geminiConfigured ?? false}
        maxUploadSizeBytes={systemStatus?.maxUploadSizeBytes}
        objectStorageConfigured={systemStatus?.objectStorageConfigured ?? false}
        onVideoCreated={handleVideoCreated}
        onOpenStudio={(videoId, clipId) => {
          setUploadModalOpen(false);
          handleOpenStudio(videoId, clipId);
        }}
        onRetryVideo={handleRetryVideo}
        activeJob={trackedJob}
        lang={lang}
      />
    </div>
  );
}

export default App;
