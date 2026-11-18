import path from 'node:path';
import type {
  ClipRecord,
  JobStage,
  ProcessingJob,
  TranscriptSegment,
  VideoRecord,
} from '../src/types';
import {
  DEFAULT_SUBTITLE_STYLE,
  UPLOADS_DIR,
  readDb,
  writeDb,
} from './db';
import { extractMonoAudio } from './processing/audioExtractor';
import {
  detectCandidateClipsHeuristic,
  parseSrtOrTextTranscript,
  type CandidateClip,
} from './processing/clipScorer';
import {
  refineCandidatesWithGemini,
  transcribeAudioWithGemini,
} from './processing/geminiClient';
import { analyzeVideo, generateThumbnail } from './processing/videoAnalyzer';

function updateJob(
  jobId: number,
  stage: JobStage,
  progress: number,
  message: string
): ProcessingJob | undefined {
  const db = readDb();
  const job = db.processingJobs.find((j) => j.id === jobId);
  if (job) {
    job.stage = stage;
    job.progress = progress;
    job.message = message;
    job.updatedAt = new Date().toISOString();
    writeDb(db);
  }
  return job;
}

export async function runVideoPipeline(params: {
  videoId: number;
  jobId: number;
  useAi: boolean;
  suppliedTranscript?: string;
  presetSegments?: TranscriptSegment[];
  transcriptSource?: 'gemini' | 'srt' | 'manual' | 'sample';
}): Promise<void> {
  const {
    videoId,
    jobId,
    useAi,
    suppliedTranscript,
    presetSegments,
    transcriptSource,
  } = params;

  try {
    const db = readDb();
    const video = db.videos.find((v) => v.id === videoId);
    if (!video) throw new Error('Video record not found');

    video.status = 'processing';
    video.errorMessage = undefined;
    writeDb(db);

    const videoPath = path.join(UPLOADS_DIR, video.filename);

    // Stage 1: Analyze video metadata
    updateJob(jobId, 'analyzing_video', 18, 'Inspecting streams and duration via ffprobe...');
    const meta = await analyzeVideo(videoPath);
    const thumbName = `video-${video.id}-cover.jpg`;
    const coverUrl = await generateThumbnail(
      videoPath,
      thumbName,
      Math.min(2, Math.max(0.2, meta.duration * 0.15))
    );

    {
      const freshDb = readDb();
      const v = freshDb.videos.find((item) => item.id === videoId);
      if (v) {
        v.duration = meta.duration;
        v.width = meta.width;
        v.height = meta.height;
        v.fps = meta.fps;
        v.hasAudio = meta.hasAudio;
        if (coverUrl) v.thumbnailUrl = coverUrl;
        writeDb(freshDb);
      }
    }

    // Stage 2 & 3: Audio extraction + Transcription
    let segments: TranscriptSegment[] = [];
    let resolvedSource: 'gemini' | 'srt' | 'manual' | 'sample' =
      transcriptSource ?? 'manual';

    if (presetSegments && presetSegments.length > 0) {
      updateJob(jobId, 'transcribing', 52, 'Loading synced transcript segments...');
      segments = presetSegments;
      resolvedSource = transcriptSource ?? 'sample';
    } else if (suppliedTranscript && suppliedTranscript.trim().length > 0) {
      updateJob(jobId, 'transcribing', 52, 'Parsing supplied SRT / transcript timestamps...');
      segments = parseSrtOrTextTranscript(suppliedTranscript, meta.duration);
      resolvedSource = 'srt';
    } else if (useAi) {
      if (!meta.hasAudio) {
        throw new Error(
          'This video does not contain an audio stream. Upload a video with audio or paste an SRT/text transcript.'
        );
      }
      updateJob(jobId, 'extracting_audio', 35, 'Extracting lightweight 16kHz mono MP3 audio...');
      const audioPath = await extractMonoAudio(videoPath, videoId);

      updateJob(
        jobId,
        'transcribing',
        56,
        'Transcribing audio and aligning timestamps with Gemini...'
      );
      segments = await transcribeAudioWithGemini(audioPath, meta.duration);
      resolvedSource = 'gemini';
    } else {
      throw new Error(
        'No transcript provided. Either enable Gemini AI Transcription or paste an SRT / text transcript for 0-cost deterministic mode.'
      );
    }

    if (segments.length === 0) {
      throw new Error('Could not parse any spoken transcript segments.');
    }

    // Save transcription
    {
      const freshDb = readDb();
      freshDb.transcriptions = freshDb.transcriptions.filter((t) => t.videoId !== videoId);
      freshDb.transcriptions.push({
        id: freshDb.nextIds.transcription++,
        videoId,
        source: resolvedSource,
        language: 'auto',
        segments,
        createdAt: new Date().toISOString(),
      });
      writeDb(freshDb);
    }

    // Stage 4: Deterministic scoring + optional single-pass LLM evaluation
    updateJob(
      jobId,
      'scoring_moments',
      74,
      useAi
        ? 'Running 100-pt deterministic filter + single-pass Gemini JSON ranking...'
        : 'Running 100-pt deterministic heuristic moment scorer...'
    );

    const config = readDb().scoringConfig;
    let candidates: CandidateClip[] = detectCandidateClipsHeuristic(segments, config);
    let scoringSource: 'heuristic' | 'gemini' = 'heuristic';

    if (useAi && candidates.length > 0) {
      candidates = await refineCandidatesWithGemini(candidates, config);
      scoringSource = 'gemini';
    }

    // Stage 5: Generate per-clip preview thumbnails & save clips
    updateJob(jobId, 'generating_thumbnails', 88, 'Generating candidate clip thumbnails...');

    const createdClips: ClipRecord[] = [];
    const currentDb = readDb();
    // Remove previous auto-generated clips for this video if re-processing
    currentDb.clips = currentDb.clips.filter((c) => c.videoId !== videoId);

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      const clipId = currentDb.nextIds.clip++;
      const midTime = (cand.startTime + cand.endTime) / 2;
      const clipThumb = await generateThumbnail(
        videoPath,
        `clip-${clipId}-preview.jpg`,
        midTime
      );

      const newClip: ClipRecord = {
        id: clipId,
        videoId,
        title: cand.title,
        hookText: cand.hookText,
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
        subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
        exportedUrl: null,
        srtUrl: null,
        thumbnailUrl: clipThumb ?? coverUrl,
        createdAt: new Date().toISOString(),
      };
      createdClips.push(newClip);
      currentDb.clips.push(newClip);
    }

    const finalVideo: VideoRecord | undefined = currentDb.videos.find(
      (v) => v.id === videoId
    );
    if (finalVideo) {
      finalVideo.status = 'ready';
      finalVideo.errorMessage = undefined;
    }
    writeDb(currentDb);

    updateJob(
      jobId,
      'completed',
      100,
      `Pipeline complete: ${createdClips.length} clips detected and scored.`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected processing error';
    const db = readDb();
    const video = db.videos.find((v) => v.id === videoId);
    if (video) {
      video.status = 'error';
      video.errorMessage = message;
      writeDb(db);
    }
    updateJob(jobId, 'failed', 100, message);
  }
}
