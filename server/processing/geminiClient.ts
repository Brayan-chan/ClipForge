import fs from 'node:fs';
import { GoogleGenAI, Type } from '@google/genai';
import type {
  ClipScoreBreakdown,
  ScoringConfig,
  TranscriptSegment,
} from '../../src/types';
import { parseSrtOrTextTranscript, type CandidateClip } from './clipScorer';

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Add it in Settings > Secrets, or switch to 0-Cost Deterministic Mode with an SRT/transcript.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

export async function transcribeAudioWithGemini(
  audioPath: string,
  videoDuration: number
): Promise<TranscriptSegment[]> {
  const ai = getAiClient();
  const audioBuffer = fs.readFileSync(audioPath);
  const maxBytes = 18 * 1024 * 1024;
  if (audioBuffer.byteLength > maxBytes) {
    throw new Error(
      `Extracted audio is ${(audioBuffer.byteLength / (1024 * 1024)).toFixed(1)} MB, exceeding the 18 MB inline limit. Trim the video or provide an SRT transcript.`
    );
  }

  const base64Audio = audioBuffer.toString('base64');

  // Step 1: Verbatim audio transcription using gemini-3.5-transcribe
  const transcribeResponse = await ai.models.generateContent({
    model: 'gemini-3.5-transcribe',
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: 'audio/mp3',
            data: base64Audio,
          },
        },
        {
          text: 'Transcribe the spoken audio accurately in its original language.',
        },
      ],
    },
  });

  const rawTranscript = (transcribeResponse.text ?? '').trim();
  if (!rawTranscript) {
    throw new Error('Transcription returned empty text. Ensure the video has clear spoken audio.');
  }

  // Step 2: Align transcript into clean timestamped segments using gemini-4-hydrogen
  try {
    const alignResponse = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: 'audio/mp3',
              data: base64Audio,
            },
          },
          {
            text: `Using this verbatim transcript and the audio timing (total duration ${videoDuration.toFixed(1)}s), split the transcript into chronological spoken segments of 3-8 seconds each with accurate start and end timestamps in seconds.\n\nTranscript:\n${rawTranscript}`,
          },
        ],
      },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              start: { type: Type.NUMBER, description: 'Start timestamp in seconds' },
              end: { type: Type.NUMBER, description: 'End timestamp in seconds' },
              text: { type: Type.STRING, description: 'Spoken phrase text' },
            },
            required: ['start', 'end', 'text'],
          },
        },
      },
    });

    const parsed = JSON.parse((alignResponse.text ?? '[]').trim()) as Array<{
      start: number;
      end: number;
      text: string;
    }>;

    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((seg, idx) => ({
        id: `seg-${idx + 1}`,
        start: Math.max(0, Math.round(seg.start * 100) / 100),
        end: Math.min(videoDuration, Math.max(seg.start + 1, Math.round(seg.end * 100) / 100)),
        text: seg.text.trim(),
      }));
    }
  } catch {
    // Fallback to sentence-proportional alignment over real duration if alignment JSON fails
  }

  return parseSrtOrTextTranscript(rawTranscript, videoDuration);
}

export async function refineCandidatesWithGemini(
  candidates: CandidateClip[],
  config: ScoringConfig
): Promise<CandidateClip[]> {
  const ai = getAiClient();
  const qualified = candidates.filter((c) => c.score >= config.llmThreshold);
  const pool = qualified.length > 0 ? qualified : candidates.slice(0, 4);
  if (pool.length === 0) return [];

  const promptPayload = pool.map((c, idx) => ({
    index: idx,
    startTime: c.startTime,
    endTime: c.endTime,
    heuristicScore: c.score,
    transcript: c.transcriptExcerpt,
  }));

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: `Evaluate these pre-filtered video clip candidates for short-form social media (TikTok, Reels, Shorts). Return structured evaluations in the same language as the transcript.
Rubric maximums:
- hook: 0-${config.hookWeight}
- infoValue: 0-${config.infoWeight}
- emotion: 0-${config.emotionWeight}
- selfContained: 0-${config.selfContainedWeight}
- durationFit: 0-${config.durationWeight}

Candidates:
${JSON.stringify(promptPayload, null, 2)}`,
    config: {
      systemInstruction:
        'You are a deterministic video editor assistant. Output strictly valid JSON scoring each candidate objectively without inventing timestamps outside the candidate range.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            index: { type: Type.INTEGER },
            title: { type: Type.STRING, description: 'Short punchy clip title (max 8 words)' },
            hookText: { type: Type.STRING, description: 'Opening hook phrase' },
            hook: { type: Type.INTEGER },
            infoValue: { type: Type.INTEGER },
            emotion: { type: Type.INTEGER },
            selfContained: { type: Type.INTEGER },
            durationFit: { type: Type.INTEGER },
            reason: { type: Type.STRING, description: 'Concise reason why this clip works' },
          },
          required: [
            'index',
            'title',
            'hookText',
            'hook',
            'infoValue',
            'emotion',
            'selfContained',
            'durationFit',
            'reason',
          ],
        },
      },
    },
  });

  const evaluated = JSON.parse((response.text ?? '[]').trim()) as Array<{
    index: number;
    title: string;
    hookText: string;
    hook: number;
    infoValue: number;
    emotion: number;
    selfContained: number;
    durationFit: number;
    reason: string;
  }>;

  const evalMap = new Map(evaluated.map((e) => [e.index, e]));

  return pool
    .map((cand, idx) => {
      const ev = evalMap.get(idx);
      if (!ev) return cand;
      const breakdown: ClipScoreBreakdown = {
        hook: Math.min(config.hookWeight, Math.max(0, ev.hook)),
        infoValue: Math.min(config.infoWeight, Math.max(0, ev.infoValue)),
        emotion: Math.min(config.emotionWeight, Math.max(0, ev.emotion)),
        selfContained: Math.min(config.selfContainedWeight, Math.max(0, ev.selfContained)),
        durationFit: Math.min(config.durationWeight, Math.max(0, ev.durationFit)),
      };
      const rawTotal =
        breakdown.hook +
        breakdown.infoValue +
        breakdown.emotion +
        breakdown.selfContained +
        breakdown.durationFit;
      const maxTotal =
        config.hookWeight +
        config.infoWeight +
        config.emotionWeight +
        config.selfContainedWeight +
        config.durationWeight;
      const score = maxTotal > 0 ? Math.min(100, Math.round((rawTotal / maxTotal) * 100)) : cand.score;

      return {
        ...cand,
        title: ev.title || cand.title,
        hookText: ev.hookText || cand.hookText,
        score,
        breakdown,
        reason: ev.reason || cand.reason,
      };
    })
    .sort((a, b) => b.score - a.score);
}
