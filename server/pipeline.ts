import type {
  ClipRecord,
  JobStage,
  TranscriptSegment,
} from '../src/types';
import fs from 'node:fs';
import { ensureClipCompositions } from '../src/utils/composition';
import {
  DEFAULT_SUBTITLE_STYLE,
  mutateDb,
  readDb,
  resolveVideoInputSource,
} from './db';
import { processingQueue } from './queue';
import { extractMonoAudio } from './processing/audioExtractor';
import {
  parseSrtOrTextTranscript,
  type CandidateClip,
} from './processing/clipScorer';
import {
  isGeminiConfigured,
  refineCandidatesWithGemini,
  transcribeAudioWithGemini,
} from './processing/geminiClient';
import { analyzeAudioEvents } from './processing/momentDetection/audioEvents';
import { detectNarrativeMoments } from './processing/momentDetection/momentDetector';
import {
  analyzeVideo,
  detectSceneChanges,
  generateThumbnail,
} from './processing/videoAnalyzer';

async function updateJob(
  jobId: number,
  stage: JobStage,
  progress: number,
  message: string
): Promise<void> {
  await mutateDb((db) => {
    const job = db.processingJobs.find((j) => j.id === jobId);
    if (job) {
      job.stage = stage;
      job.progress = progress;
      job.message = message;
      job.updatedAt = new Date().toISOString();
    }
  });
}

export async function runVideoPipeline(params: {
  videoId: number;
  jobId: number;
  useAi: boolean;
  suppliedTranscript?: string;
  presetSegments?: TranscriptSegment[];
  transcriptSource?: 'gemini' | 'srt' | 'manual' | 'sample';
  requestedClipCount?: number;
  temporaryInputPath?: string;
  editorOnly?: boolean;
}): Promise<void> {
  const {
    videoId,
    jobId,
    useAi,
    suppliedTranscript,
    presetSegments,
    transcriptSource,
    requestedClipCount = 5,
    temporaryInputPath,
    editorOnly = false,
  } = params;
  const maxClips = Math.max(1, Math.min(10, Math.round(requestedClipCount)));

  await processingQueue.run(async () => {
    try {
      const initialVideo = readDb().videos.find((v) => v.id === videoId);
      if (!initialVideo) throw new Error('Video record not found');

      await mutateDb((db) => {
        const v = db.videos.find((item) => item.id === videoId);
        if (v) {
          v.status = 'processing';
          v.errorMessage = undefined;
        }
      });

      const videoPath = temporaryInputPath ?? resolveVideoInputSource(initialVideo);

      // Stage 1: Stream metadata + visual scene change detection
      await updateJob(
        jobId,
        'analyzing_video',
        18,
        'Inspecting streams, duration & visual scene changes via FFmpeg...'
      );
      const meta = await analyzeVideo(videoPath);
      const coverUrl = await generateThumbnail(
        videoPath,
        `video-${videoId}-cover.jpg`,
        Math.min(2, Math.max(0.2, meta.duration * 0.15))
      );

      await mutateDb((db) => {
        const v = db.videos.find((item) => item.id === videoId);
        if (v) {
          v.duration = meta.duration;
          v.width = meta.width;
          v.height = meta.height;
          v.fps = meta.fps;
          v.hasAudio = meta.hasAudio;
          if (coverUrl) v.thumbnailUrl = coverUrl;
        }
      });

      if (editorOnly) {
        let createdClipId = 0;
        await mutateDb((db) => {
          db.clips = db.clips.filter((clip) => clip.videoId !== videoId);
          createdClipId = db.nextIds.clip++;
          db.clips.push({
            id: createdClipId,
            videoId,
            title: initialVideo.title,
            hookText: '',
            hookType: 'manual-import',
            contextStatus: 'self-contained',
            sceneChanges: 0,
            startTime: 0,
            endTime: meta.duration,
            score: 0,
            breakdown: { hook: 0, infoValue: 0, emotion: 0, selfContained: 0, durationFit: 0 },
            reason: 'Imported directly for formatting and editing.',
            scoringSource: 'manual',
            status: 'approved',
            aspectRatio: '9:16',
            framingMode: 'crop',
            cropX: 50,
            cropY: 50,
            zoom: 1,
            compositions: ensureClipCompositions({}),
            exportVariants: {},
            subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE, enabled: false },
            exportedUrl: null,
            srtUrl: null,
            thumbnailUrl: coverUrl,
            createdAt: new Date().toISOString(),
          });
          const video = db.videos.find((item) => item.id === videoId);
          if (video) {
            video.status = 'ready';
            video.errorMessage = undefined;
          }
        });
        await updateJob(
          jobId,
          'completed',
          100,
          `Video imported for editing. One full-length clip is ready in Clip Studio.`
        );
        return;
      }

      const sceneTimestamps = await detectSceneChanges(videoPath, meta.duration);

      // Stage 2 & 3: Audio extraction + Transcription (Interactions API or Local SRT/Text)
      let segments: TranscriptSegment[] = [];
      let resolvedSource: 'gemini' | 'srt' | 'manual' | 'sample' =
        transcriptSource ?? 'manual';

      if (presetSegments && presetSegments.length > 0) {
        await updateJob(jobId, 'transcribing', 52, 'Loading synced transcript segments...');
        segments = presetSegments;
        resolvedSource = transcriptSource ?? 'sample';
      } else if (suppliedTranscript && suppliedTranscript.trim().length > 0) {
        await updateJob(jobId, 'transcribing', 52, 'Parsing supplied SRT / transcript timestamps...');
        segments = parseSrtOrTextTranscript(suppliedTranscript, meta.duration);
        resolvedSource = 'srt';
      } else if (useAi && isGeminiConfigured()) {
        if (!meta.hasAudio) {
          throw new Error(
            'This video has no audio stream. Paste an SRT/text transcript to run deterministic scoring.'
          );
        }
        await updateJob(jobId, 'extracting_audio', 35, 'Extracting lightweight 16kHz mono MP3 audio...');
        const audioPath = await extractMonoAudio(videoPath, videoId);

        await updateJob(
          jobId,
          'transcribing',
          56,
          'Transcribing audio via Gemini 3.5 Transcribe Interactions API...'
        );
        segments = await transcribeAudioWithGemini(audioPath, meta.duration);
        resolvedSource = 'gemini';
      } else {
        throw new Error(
          'No transcript provided. Paste an SRT/transcript for 0-cost mode, or enable Gemini AI with GEMINI_API_KEY.'
        );
      }

      if (segments.length === 0) {
        throw new Error('Could not parse any spoken transcript segments.');
      }

      // Never score or export subtitle ranges beyond the real media duration.
      // A mismatched SRT may be longer than the downloaded/cut source video.
      segments = segments
        .filter((segment) => segment.start < meta.duration)
        .map((segment) => ({
          ...segment,
          start: Math.max(0, segment.start),
          end: Math.min(meta.duration, Math.max(segment.start + 0.08, segment.end)),
        }))
        .filter((segment) => segment.end > segment.start);
      if (segments.length === 0) {
        throw new Error('Transcript timestamps do not overlap the video duration.');
      }

      await mutateDb((db) => {
        db.transcriptions = db.transcriptions.filter((t) => t.videoId !== videoId);
        db.transcriptions.push({
          id: db.nextIds.transcription++,
          videoId,
          source: resolvedSource,
          language: 'auto',
          segments,
          createdAt: new Date().toISOString(),
        });
      });

      // Stage 4: Event-based deterministic detection + optional Gemini refinement.
      await updateJob(
        jobId,
        'scoring_moments',
        74,
        'Detecting complete narrative events, reactions and natural speech boundaries...'
      );

      const config = readDb().scoringConfig;
      const audioEvents = meta.hasAudio
        ? await analyzeAudioEvents(videoPath, meta.duration)
        : { energyPeaks: [], silenceEnds: [], available: false };
      let candidates: CandidateClip[] = detectNarrativeMoments({
        segments,
        config,
        sceneTimestamps,
        audio: audioEvents,
        maxClips,
      });
      candidates = candidates
        .map((candidate) => ({ ...candidate, endTime: Math.min(meta.duration, candidate.endTime) }))
        .filter((candidate) => candidate.endTime - candidate.startTime >= 8)
        .slice(0, maxClips);
      let scoringSource: 'heuristic' | 'gemini' = 'heuristic';
      let fallbackNote = '';

      if (useAi && candidates.length > 0) {
        if (isGeminiConfigured()) {
          try {
            await updateJob(
              jobId,
              'scoring_moments',
              82,
              'Ranking top filtered transcript excerpts via Gemini 4 Hydrogen...'
            );
            candidates = (await refineCandidatesWithGemini(candidates, config)).slice(0, maxClips);
            scoringSource = 'gemini';
          } catch (aiErr) {
            // Deterministic fallback if Gemini fails
            fallbackNote =
              aiErr instanceof Error
                ? ` (Gemini fallback -> deterministic rubric: ${aiErr.message.slice(0, 60)})`
                : ' (Gemini unavailable -> used deterministic rubric)';
          }
        } else {
          fallbackNote = ' (GEMINI_API_KEY missing -> used deterministic rubric)';
        }
      }

      // Stage 5: Generate lightweight preview thumbnails. Final MP4 rendering
      // is intentionally deferred until the user selects "Compile & Export"
      // in Clip Studio. Rendering every candidate here made local processing
      // several minutes slower and produced files the user might never use.
      await updateJob(jobId, 'generating_thumbnails', 86, 'Generating clip thumbnails & preparing cuts...');

      const thumbUrls: Array<string | null> = [];
      const clipIds: number[] = [];
      await mutateDb((db) => {
        db.clips = db.clips.filter((c) => c.videoId !== videoId);
        for (let i = 0; i < candidates.length; i++) {
          clipIds.push(db.nextIds.clip++);
        }
      });

      for (let i = 0; i < candidates.length; i++) {
        const cand = candidates[i];
        const midTime = (cand.startTime + cand.endTime) / 2;
        const thumb = await generateThumbnail(
          videoPath,
          `clip-${clipIds[i]}-preview.jpg`,
          midTime
        );
        thumbUrls.push(thumb);
      }

      const createdClips: ClipRecord[] = [];
      await mutateDb((db) => {
        for (let i = 0; i < candidates.length; i++) {
          const cand = candidates[i];
          const newClip: ClipRecord = {
            id: clipIds[i],
            videoId,
            title: cand.title,
            hookText: cand.hookText,
            hookType: cand.hookType,
            contextStatus: cand.contextStatus,
            sceneChanges: cand.sceneChanges,
            startTime: cand.startTime,
            endTime: cand.endTime,
            score: cand.score,
            breakdown: cand.breakdown,
            reason: cand.reason,
            scoringSource,
            status: i === 0 ? 'approved' : 'candidate',
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
            thumbnailUrl: thumbUrls[i] ?? coverUrl,
            createdAt: new Date().toISOString(),
          };
          db.clips.push(newClip);
          createdClips.push(newClip);
        }
      });

      await mutateDb((db) => {
        const finalVideo = db.videos.find((v) => v.id === videoId);
        if (finalVideo) {
          finalVideo.status = 'ready';
          finalVideo.errorMessage = undefined;
        }
      });

      await updateJob(
        jobId,
        'completed',
        100,
        `Pipeline complete: ${createdClips.length} clip candidates ready. Open Clip Studio to preview and compile only the versions you want.${fallbackNote}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected processing error';
      await mutateDb((db) => {
        const video = db.videos.find((v) => v.id === videoId);
        if (video) {
          video.status = 'error';
          video.errorMessage = message;
        }
      });
      await updateJob(jobId, 'failed', 100, message);
    } finally {
      if (temporaryInputPath) {
        await fs.promises.unlink(temporaryInputPath).catch(() => undefined);
      }
    }
  });
}
