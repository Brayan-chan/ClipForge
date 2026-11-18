import type {
  ClipScoreBreakdown,
  ScoringConfig,
  TranscriptSegment,
} from '../../src/types';
import { DEFAULT_SCORING_CONFIG } from '../db';

export interface CandidateClip {
  title: string;
  hookText: string;
  startTime: number;
  endTime: number;
  score: number;
  breakdown: ClipScoreBreakdown;
  reason: string;
  transcriptExcerpt: string;
}

const HOOK_PATTERNS = [
  /\b(por qué|cómo|secreto|error|nadie te dice|la verdad|mucha gente|todos piensan|cuidado|problema|mito|realmente)\b/i,
  /\b(why|how|secret|mistake|nobody tells|the truth|most people|stop doing|here is why|problem|actually)\b/i,
  /\?/,
  /\b\d+\b/,
];

const INFO_PATTERNS = [
  /\b(paso|arquitectura|sistema|costo|presupuesto|ffmpeg|modelo|pipeline|algoritmo|regla|datos|ejemplo|estructura|ahorrar|gratis|velocidad)\b/i,
  /\b(step|architecture|system|cost|budget|model|pipeline|algorithm|rule|data|example|framework|save|free|fast|because)\b/i,
  /\b(primero|segundo|tercero|entonces|por eso|la clave|significa)\b/i,
];

const EMOTION_PATTERNS = [
  /\b(fracasan|fracaso|imposible|peligroso|increíble|brutal|caro|cero|nunca|siempre|controver|debate|fuerte|sorprendente)\b/i,
  /\b(fail|failure|impossible|dangerous|incredible|expensive|zero|never|always|controvers|debate|crazy|huge)\b/i,
  /!/,
];

const DANGLING_STARTS = /^(y |pero |o |and |but |so |then |entonces |también |also )/i;

export function parseSrtOrTextTranscript(
  rawText: string,
  videoDuration: number
): TranscriptSegment[] {
  const trimmed = rawText.trim();
  if (!trimmed) return [];

  // Try SRT / VTT timestamp format: 00:00:12,000 --> 00:00:19,000
  const srtBlocks = trimmed.split(/\r?\n\r?\n+/);
  const parsedSrt: TranscriptSegment[] = [];
  const timeRegex =
    /(\d{1,2}:)?(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})[,.](\d{3})/;

  for (const block of srtBlocks) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const timeLineIdx = lines.findIndex((l) => timeRegex.test(l));
    if (timeLineIdx !== -1) {
      const match = lines[timeLineIdx].match(timeRegex);
      if (match) {
        const startH = match[1] ? parseInt(match[1], 10) : 0;
        const startM = parseInt(match[2], 10);
        const startS = parseInt(match[3], 10);
        const startMs = parseInt(match[4], 10);
        const endH = match[5] ? parseInt(match[5], 10) : 0;
        const endM = parseInt(match[6], 10);
        const endS = parseInt(match[7], 10);
        const endMs = parseInt(match[8], 10);
        const start = startH * 3600 + startM * 60 + startS + startMs / 1000;
        const end = endH * 3600 + endM * 60 + endS + endMs / 1000;
        const text = lines.slice(timeLineIdx + 1).join(' ').replace(/<[^>]+>/g, '').trim();
        if (text) {
          parsedSrt.push({
            id: `seg-${parsedSrt.length + 1}`,
            start: Math.round(start * 100) / 100,
            end: Math.round(Math.max(start + 1, end) * 100) / 100,
            text,
          });
        }
      }
    }
  }
  if (parsedSrt.length > 0) return parsedSrt;

  // Try simple [MM:SS] or MM:SS lines
  const lineSegments: TranscriptSegment[] = [];
  const simpleLines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const simpleTimeRegex = /^\[?(\d{1,2}):(\d{2})(?::(\d{2}))?\]?\s*[-–:]?\s*(.+)$/;
  for (const line of simpleLines) {
    const m = line.match(simpleTimeRegex);
    if (m) {
      const p1 = parseInt(m[1], 10);
      const p2 = parseInt(m[2], 10);
      const p3 = m[3] ? parseInt(m[3], 10) : null;
      const start = p3 !== null ? p1 * 3600 + p2 * 60 + p3 : p1 * 60 + p2;
      lineSegments.push({
        id: `seg-${lineSegments.length + 1}`,
        start,
        end: start + 5,
        text: m[4].trim(),
      });
    }
  }
  if (lineSegments.length > 0) {
    for (let i = 0; i < lineSegments.length; i++) {
      if (i < lineSegments.length - 1) {
        lineSegments[i].end = Math.max(lineSegments[i].start + 1.5, lineSegments[i + 1].start);
      } else {
        lineSegments[i].end = Math.max(lineSegments[i].start + 4, videoDuration || lineSegments[i].start + 6);
      }
    }
    return lineSegments;
  }

  // Fallback: split plain prose into sentences evenly spread over videoDuration
  const sentences = trimmed
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length === 0) return [];
  const totalWords = sentences.reduce((acc, s) => acc + s.split(/\s+/).length, 0) || 1;
  const effectiveDuration = Math.max(videoDuration, sentences.length * 4);
  let cursor = 0;
  return sentences.map((sentence, idx) => {
    const words = sentence.split(/\s+/).length;
    const slice = Math.max(2.5, (words / totalWords) * effectiveDuration);
    const start = Math.round(cursor * 100) / 100;
    const end =
      idx === sentences.length - 1
        ? Math.round(effectiveDuration * 100) / 100
        : Math.round(Math.min(effectiveDuration, cursor + slice) * 100) / 100;
    cursor = end;
    return {
      id: `seg-${idx + 1}`,
      start,
      end,
      text: sentence,
    };
  });
}

export function scoreWindow(
  windowSegs: TranscriptSegment[],
  config: ScoringConfig = DEFAULT_SCORING_CONFIG
): {
  score: number;
  breakdown: ClipScoreBreakdown;
  reason: string;
  title: string;
  hookText: string;
} {
  const firstText = windowSegs[0]?.text ?? '';
  const fullText = windowSegs.map((s) => s.text).join(' ');
  const duration = Math.max(
    1,
    (windowSegs[windowSegs.length - 1]?.end ?? 0) - (windowSegs[0]?.start ?? 0)
  );

  // 1. Hook (0..hookWeight)
  let hookHits = 0;
  for (const rx of HOOK_PATTERNS) {
    if (rx.test(firstText)) hookHits += 1;
  }
  if (firstText.length >= 28 && firstText.length <= 120) hookHits += 0.6;
  const hookRatio = Math.min(1, 0.35 + hookHits * 0.25);
  const hook = Math.round(hookRatio * config.hookWeight);

  // 2. Info Value (0..infoWeight)
  let infoHits = 0;
  for (const rx of INFO_PATTERNS) {
    if (rx.test(fullText)) infoHits += 1;
  }
  const wordCount = fullText.split(/\s+/).filter(Boolean).length;
  const densityBonus = wordCount >= 22 ? 0.25 : 0.1;
  const infoRatio = Math.min(1, 0.3 + infoHits * 0.22 + densityBonus);
  const infoValue = Math.round(infoRatio * config.infoWeight);

  // 3. Emotion / Controversy (0..emotionWeight)
  let emotionHits = 0;
  for (const rx of EMOTION_PATTERNS) {
    if (rx.test(fullText)) emotionHits += 1;
  }
  const emotionRatio = Math.min(1, 0.25 + emotionHits * 0.28);
  const emotion = Math.round(emotionRatio * config.emotionWeight);

  // 4. Self-Contained Context (0..selfContainedWeight)
  let selfRatio = 0.85;
  if (DANGLING_STARTS.test(firstText)) selfRatio -= 0.28;
  if (/[.!?]$/.test(windowSegs[windowSegs.length - 1]?.text.trim() ?? '')) {
    selfRatio += 0.15;
  }
  selfRatio = Math.max(0.25, Math.min(1, selfRatio));
  const selfContained = Math.round(selfRatio * config.selfContainedWeight);

  // 5. Duration Fit (0..durationWeight)
  let durationRatio = 0.5;
  if (duration >= 14 && duration <= 30) durationRatio = 1.0;
  else if (duration >= config.minClipSeconds && duration <= config.maxClipSeconds)
    durationRatio = 0.78;
  else if (duration >= 8) durationRatio = 0.55;
  const durationFit = Math.round(durationRatio * config.durationWeight);

  const rawTotal = hook + infoValue + emotion + selfContained + durationFit;
  const maxPossible =
    config.hookWeight +
    config.infoWeight +
    config.emotionWeight +
    config.selfContainedWeight +
    config.durationWeight;
  const normalizedScore =
    maxPossible > 0 ? Math.min(100, Math.round((rawTotal / maxPossible) * 100)) : 0;

  const reasons: string[] = [];
  if (hook >= config.hookWeight * 0.7) reasons.push('Strong opening hook');
  if (infoValue >= config.infoWeight * 0.7) reasons.push('High informational density');
  if (emotion >= config.emotionWeight * 0.65) reasons.push('Engaging tension/contrast');
  if (selfContained >= config.selfContainedWeight * 0.75) reasons.push('Self-contained thought');
  if (reasons.length === 0) reasons.push('Structured spoken segment');

  const words = firstText.replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);
  const shortTitle =
    words.slice(0, 7).join(' ') + (words.length > 7 ? '...' : '');

  return {
    score: normalizedScore,
    breakdown: { hook, infoValue, emotion, selfContained, durationFit },
    reason: reasons.join(' · '),
    title: shortTitle || 'Highlight Clip',
    hookText: firstText.slice(0, 120),
  };
}

export function detectCandidateClipsHeuristic(
  segments: TranscriptSegment[],
  config: ScoringConfig = DEFAULT_SCORING_CONFIG
): CandidateClip[] {
  if (segments.length === 0) return [];

  const totalDur =
    (segments[segments.length - 1]?.end ?? 0) - (segments[0]?.start ?? 0);
  const candidates: CandidateClip[] = [];
  const minDur = Math.max(6, Math.min(config.minClipSeconds, Math.floor(totalDur * 0.45)));
  const maxDur =
    totalDur > config.minClipSeconds * 1.8
      ? Math.min(config.maxClipSeconds, Math.max(minDur + 4, Math.round(totalDur * 0.52)))
      : Math.max(minDur + 5, config.maxClipSeconds);

  for (let i = 0; i < segments.length; i++) {
    const startSeg = segments[i];
    const windowSegs: TranscriptSegment[] = [startSeg];
    for (let j = i + 1; j < segments.length; j++) {
      const nextSeg = segments[j];
      const projectedDur = nextSeg.end - startSeg.start;
      if (projectedDur > maxDur) break;
      windowSegs.push(nextSeg);
      const currentDur = nextSeg.end - startSeg.start;
      if (currentDur >= minDur) {
        const evalResult = scoreWindow(windowSegs, config);
        candidates.push({
          title: evalResult.title,
          hookText: evalResult.hookText,
          startTime: Math.round(startSeg.start * 100) / 100,
          endTime: Math.round(nextSeg.end * 100) / 100,
          score: evalResult.score,
          breakdown: evalResult.breakdown,
          reason: evalResult.reason,
          transcriptExcerpt: windowSegs.map((s) => s.text).join(' '),
        });
      }
    }
  }

  // Fallback if total video is shorter than minDur
  if (candidates.length === 0 && segments.length > 0) {
    const evalResult = scoreWindow(segments, config);
    candidates.push({
      title: evalResult.title,
      hookText: evalResult.hookText,
      startTime: Math.round(segments[0].start * 100) / 100,
      endTime: Math.round(segments[segments.length - 1].end * 100) / 100,
      score: evalResult.score,
      breakdown: evalResult.breakdown,
      reason: evalResult.reason,
      transcriptExcerpt: segments.map((s) => s.text).join(' '),
    });
  }

  // Sort descending by score and deduplicate overlapping intervals (>45% overlap)
  candidates.sort((a, b) => b.score - a.score);
  const selected: CandidateClip[] = [];
  for (const cand of candidates) {
    const overlaps = selected.some((existing) => {
      const overlapStart = Math.max(existing.startTime, cand.startTime);
      const overlapEnd = Math.min(existing.endTime, cand.endTime);
      if (overlapEnd <= overlapStart) return false;
      const overlapDur = overlapEnd - overlapStart;
      const candDur = Math.max(1, cand.endTime - cand.startTime);
      return overlapDur / candDur > 0.45;
    });
    if (!overlaps) {
      selected.push(cand);
    }
    if (selected.length >= 6) break;
  }

  return selected;
}
