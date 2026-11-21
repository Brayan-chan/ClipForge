import type { ScoringConfig, TranscriptSegment } from '../../../src/types';
import type { CandidateClip } from '../clipScorer';
import type { AudioEventAnalysis } from './audioEvents';

const REACTION = /\b(guau|wow|uf+|uoh|no me lo puedo creer|madre m[ií]a|dios|brutal|incre[ií]ble|locura|qu[eé] guapo|por dios|ojito|atentos|jaj+a|ja ja|risas|se cay[oó]|what|oh my god|holy|crazy|amazing|laugh)/i;
const REVEAL = /\b(3\s*2\s*1|ah[ií] est[aá]|mirad esto|fijaos|atentos|empieza|vamos a ver|resultado|por fin|en persona|revel|unbox|descubr|look at this|here it is|watch this|finally)/i;
const SETUP = /\b(voy a|vamos a|intentar|a ver si|qu[eé] pasa si|tengo miedo|el problema|la cosa es|espera|antes de|let'?s|i'?m going to|what if|wait)/i;
const RESOLUTION = /\b(y ya est[aá]|al final|as[ií] que|esa es|por eso|en resumen|total|listo|terminar|conclusi[oó]n|there you go|in the end|that'?s why|done)/i;
const LAUGHTER_OR_SFX = /\[(risas?|m[uú]sica|aplausos?|gritos?)\]/i;
const FILLER_ONLY = /^(eh+|hm+|bueno|vale|a ver|pues|o sea|y+|no+|s[ií]+|okay|well)[\s,.!?-]*$/i;
const BAD_START = /^(y|pero|porque|aunque|entonces|adem[aá]s|tambi[eé]n|as[ií] que|por eso|pues|esto|eso|[ée]l|ella|ellos|media|and|but|because|so|then|also|this|that|it)\b/i;
const TRANSCRIPT_FRAGMENT_START = /^(aqu[ií] esto|por aqu[ií]|de y|y y|eh[, ]|hm[, ]|media[, ])/i;
const BAD_END = /\b(y|o|pero|porque|aunque|que|para|de|del|con|sin|si|cuando|como|and|or|but|because|that|to|with|if)$/i;
const CONFLICT = /\b(error|fallo|pierdo|perd[ií]|rompi[oó]|choc[oó]|imposible|problema|peor|enfad|trampa|riesgo|cuidado|fail|lost|broke|crash|impossible|problem|worst|angry|cheat|risk)/i;
const STRONG_OPINION = /\b(creo que|para m[ií]|la verdad|es absurdo|es una locura|no tiene sentido|me encanta|odio|lo mejor|lo peor|i think|honestly|makes no sense|i love|i hate|the best|the worst)/i;
const ACHIEVEMENT = /\b(gan[eé]|ganamos|consegu[ií]|logr[eé]|primero|r[eé]cord|victoria|completado|lo hice|we won|i won|made it|record|victory|completed|did it)/i;
const CONTRAST = /\b(pero|aunque|sin embargo|en realidad|resulta que|hasta que|de repente|but|although|however|actually|turns out|suddenly)\b/i;

interface EventSeed {
  index: number;
  strength: number;
  kinds: string[];
}

function near(values: number[], time: number, radius: number): boolean {
  return values.some((value) => Math.abs(value - time) <= radius);
}

function sentenceLooksClosed(text: string): boolean {
  const clean = text.trim();
  return /[.!?\]”"]$/.test(clean) && !BAD_END.test(clean.replace(/[.!?\]”"]+$/, '').trim());
}

function buildSeeds(
  segments: TranscriptSegment[],
  audio: AudioEventAnalysis,
  sceneTimestamps: number[]
): EventSeed[] {
  const seeds: EventSeed[] = [];
  segments.forEach((segment, index) => {
    const kinds: string[] = [];
    let strength = 0;
    // Words are secondary hints. The primary event anchors below come from
    // relative audio changes and the video itself.
    if (REACTION.test(segment.text)) { strength += 1.25; kinds.push('reaction'); }
    if (REVEAL.test(segment.text)) { strength += 1.2; kinds.push('reveal'); }
    if (SETUP.test(segment.text)) { strength += 0.55; kinds.push('setup'); }
    if (RESOLUTION.test(segment.text)) { strength += 0.55; kinds.push('resolution'); }
    if (CONFLICT.test(segment.text)) { strength += 1; kinds.push('conflict'); }
    if (STRONG_OPINION.test(segment.text)) { strength += 0.9; kinds.push('opinion'); }
    if (ACHIEVEMENT.test(segment.text)) { strength += 1; kinds.push('achievement'); }
    if (CONTRAST.test(segment.text)) { strength += 0.45; kinds.push('turn'); }
    if (LAUGHTER_OR_SFX.test(segment.text)) { strength += 1.4; kinds.push('audio cue'); }
    const mid = (segment.start + segment.end) / 2;
    if (near(audio.energyPeaks, mid, 2.5)) { strength += 2.8; kinds.push('energy peak'); }
    if (near(sceneTimestamps, mid, 2.4)) { strength += 3; kinds.push('visual change'); }
    if (/[?!¡¿]/.test(segment.text)) { strength += 0.3; kinds.push('expressive speech'); }
    const wordsPerSecond = segment.text.split(/\s+/).filter(Boolean).length / Math.max(0.5, segment.end - segment.start);
    if (wordsPerSecond >= 3.6) { strength += 0.35; kinds.push('fast pace'); }
    if (strength >= 1.15) seeds.push({ index, strength, kinds });
  });

  // Coverage anchors keep quiet, contextual highlights in the candidate pool.
  const coverageStep = 24;
  const firstTime = segments[0]?.start ?? 0;
  const lastTime = segments[segments.length - 1]?.end ?? firstTime;
  for (let time = firstTime + coverageStep / 2; time < lastTime; time += coverageStep) {
    if (seeds.some((seed) => Math.abs((segments[seed.index].start + segments[seed.index].end) / 2 - time) <= 9)) continue;
    let closest = 0;
    let distance = Number.POSITIVE_INFINITY;
    segments.forEach((segment, index) => {
      const current = Math.abs((segment.start + segment.end) / 2 - time);
      if (current < distance) { closest = index; distance = current; }
    });
    seeds.push({ index: closest, strength: 0.8, kinds: ['coverage'] });
  }
  return seeds;
}

function refineBoundaries(
  segments: TranscriptSegment[],
  seed: EventSeed,
  audio: AudioEventAnalysis,
  config: ScoringConfig
): TranscriptSegment[] {
  const anchor = segments[seed.index];
  let start = seed.index;
  let end = seed.index;
  const maxBefore = Math.min(30, Math.max(16, config.maxClipSeconds * 0.42));
  const maxAfter = Math.min(34, Math.max(18, config.maxClipSeconds * 0.65));
  const silenceStart = audio.silenceEnds
    .filter((time) => time >= anchor.start - maxBefore && time <= anchor.start - 4)
    .sort((a, b) => b - a)[0];
  const desiredStartTime = silenceStart ?? anchor.start - Math.min(maxBefore, 18);

  // Recover setup/context, stopping at a meaningful pause or completed prior thought.
  while (start > 0 && anchor.start - segments[start - 1].start <= maxBefore) {
    const previous = segments[start - 1];
    const gap = segments[start].start - previous.end;
    const recoveredContext = anchor.start - previous.start;
    if (previous.start <= desiredStartTime && recoveredContext >= 10) {
      start--;
      break;
    }
    if (recoveredContext >= 14 && gap > 1.15 && sentenceLooksClosed(previous.text)) break;
    start--;
    if (recoveredContext >= 8 && SETUP.test(previous.text) && !BAD_START.test(previous.text.trim())) break;
  }
  while (
    start < seed.index &&
    (BAD_START.test(segments[start].text.trim()) ||
      TRANSCRIPT_FRAGMENT_START.test(segments[start].text.trim()) ||
      FILLER_ONLY.test(segments[start].text.trim()))
  ) start++;

  // Keep the reaction and consequence; never stop solely because min duration was reached.
  while (end < segments.length - 1 && segments[end + 1].end - anchor.start <= maxAfter) {
    const current = segments[end];
    const next = segments[end + 1];
    const gap = next.start - current.end;
    const reachedUsefulLength = current.end - segments[start].start >= Math.max(10, config.minClipSeconds);
    const naturalPause = gap >= 0.65 || near(audio.silenceEnds, current.end, 0.45);
    if (reachedUsefulLength && sentenceLooksClosed(current.text) && naturalPause) break;
    end++;
    if (reachedUsefulLength && RESOLUTION.test(next.text) && sentenceLooksClosed(next.text)) break;
  }

  // If a cue is split by caption timing, extend until its grammatical closure.
  while (
    end < segments.length - 1 &&
    !sentenceLooksClosed(segments[end].text) &&
    segments[end + 1].end - segments[start].start <= config.maxClipSeconds
  ) end++;

  return segments.slice(start, end + 1);
}

function evaluateEvent(
  window: TranscriptSegment[],
  seed: EventSeed,
  audio: AudioEventAnalysis,
  sceneTimestamps: number[],
  config: ScoringConfig
): CandidateClip | null {
  const first = window[0].text.trim();
  const last = window[window.length - 1].text.trim();
  const text = window.map((segment) => segment.text).join(' ').replace(/\s+/g, ' ').trim();
  const startTime = window[0].start;
  const endTime = window[window.length - 1].end;
  const duration = endTime - startTime;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const hasReaction = REACTION.test(text) || LAUGHTER_OR_SFX.test(text);
  const hasReveal = REVEAL.test(text);
  const hasSetup = SETUP.test(text.slice(0, Math.ceil(text.length * 0.55)));
  const hasResolution = RESOLUTION.test(text) || sentenceLooksClosed(last);
  const hasConflict = CONFLICT.test(text);
  const hasOpinion = STRONG_OPINION.test(text);
  const hasAchievement = ACHIEVEMENT.test(text);
  const hasTurn = CONTRAST.test(text);
  const hasVisualAnchor = seed.kinds.includes('visual change');
  const hasAudioAnchor = seed.kinds.includes('energy peak') || seed.kinds.includes('audio cue');
  const energyCount = audio.energyPeaks.filter((time) => time >= startTime && time <= endTime).length;
  const sceneChanges = sceneTimestamps.filter((time) => time >= startTime && time <= endTime).length;
  const startsBadly = BAD_START.test(first) || TRANSCRIPT_FRAGMENT_START.test(first) || FILLER_ONLY.test(first);
  const endsBadly = BAD_END.test(last.replace(/[,.!?]+$/, '').trim()) || !hasResolution;

  // Reject only structurally invalid windows. Quality is handled by weighted
  // scoring so quiet humor and opinions can compete with loud reactions.
  if (duration < 8 || duration > config.maxClipSeconds + 5) return null;
  if (wordCount < 16) return null;

  const opening = window.slice(0, Math.max(1, Math.ceil(window.length * 0.28))).map((item) => item.text).join(' ');
  const later = window.slice(Math.max(1, Math.floor(window.length * 0.28))).map((item) => item.text).join(' ');
  const hookRatio = Math.min(1, 0.12 +
    (REACTION.test(opening) || REVEAL.test(opening) ? 0.38 : 0) +
    (SETUP.test(opening) || CONFLICT.test(opening) || STRONG_OPINION.test(opening) ? 0.24 : 0) +
    (/[?!¡¿]/.test(opening) ? 0.16 : 0) +
    (opening.split(/\s+/).length <= 42 ? 0.08 : 0));
  const payoffRatio = Math.min(1, 0.08 +
    (REVEAL.test(later) ? 0.28 : 0) + (REACTION.test(later) ? 0.22 : 0) +
    (RESOLUTION.test(later) || hasAchievement ? 0.26 : 0) +
    (hasTurn ? 0.14 : 0) + (hasConflict ? 0.1 : 0) +
    (hasVisualAnchor ? 0.2 : 0) + (hasAudioAnchor ? 0.12 : 0));
  const emotionRatio = Math.min(1, 0.08 + (hasReaction ? 0.36 : 0) +
    (hasConflict ? 0.2 : 0) + (hasOpinion ? 0.14 : 0) +
    Math.min(0.22, energyCount * 0.08) + (LAUGHTER_OR_SFX.test(text) ? 0.14 : 0));
  const standaloneRatio = Math.max(0, Math.min(1, 0.72 + (hasSetup ? 0.14 : 0) +
    (hasResolution ? 0.14 : 0) - (startsBadly ? 0.42 : 0) - (endsBadly ? 0.38 : 0)));
  const visualRatio = Math.min(1, 0.08 + (hasVisualAnchor ? 0.45 : 0) +
    Math.min(0.38, sceneChanges * 0.1) + (hasReveal ? 0.08 : 0));
  const spokenRate = wordCount / Math.max(1, duration);
  const paceRatio = Math.min(1, 0.18 +
    (duration >= config.minClipSeconds && duration <= 42 ? 0.32 : 0.16) +
    (spokenRate >= 2.1 && spokenRate <= 4.8 ? 0.24 : 0.08) +
    Math.min(0.18, energyCount * 0.06) + (sceneChanges > 0 ? 0.08 : 0));
  const closureRatio = Math.max(0, Math.min(1,
    (sentenceLooksClosed(last) ? 0.72 : 0.18) + (hasResolution ? 0.28 : 0) - (endsBadly ? 0.4 : 0)));
  const infoRatio = Math.min(1, payoffRatio * 0.45 + visualRatio * 0.55);
  const selfContainedRatio = Math.min(1, standaloneRatio * 0.72 + closureRatio * 0.28);
  const maxWeight = Math.max(1, config.hookWeight + config.infoWeight + config.emotionWeight + config.selfContainedWeight + config.durationWeight);
  const weightedScore = (hookRatio * config.hookWeight + infoRatio * config.infoWeight +
    emotionRatio * config.emotionWeight + selfContainedRatio * config.selfContainedWeight +
    paceRatio * config.durationWeight) / maxWeight * 100;
  // A convex calibration curve prevents ordinary candidates from saturating at
  // 100 merely because several broad heuristics fired at once.
  let score = Math.round(100 * Math.pow(Math.max(0, weightedScore) / 100, 1.4));
  if (hasVisualAnchor) score += 4;
  if (hasAudioAnchor) score += 3;
  if (startsBadly && !hasSetup) score -= 10;
  if (endsBadly) score -= 14;
  if (payoffRatio < 0.28 && !hasVisualAnchor && !hasAudioAnchor) score -= 9;
  if (seed.kinds.includes('coverage') && payoffRatio < 0.35 && emotionRatio < 0.35) score -= 6;
  const exceptionalEvidence =
    payoffRatio >= 0.72 && selfContainedRatio >= 0.82 && closureRatio >= 0.8 &&
    (hasVisualAnchor || hasAudioAnchor) &&
    (hasReveal || hasReaction || hasResolution || hasAchievement);
  if (startsBadly || endsBadly) score = Math.min(score, 72);
  else if (payoffRatio < 0.4) score = Math.min(score, 76);
  if (!hasReveal && !hasReaction && !hasResolution && !hasAchievement && !hasOpinion) {
    score = Math.min(score, 70);
  }
  // 90+ is reserved for complete moments supported by several independent
  // audiovisual signals. Even exceptional heuristic results stop at 96 because
  // this is an estimate, not certainty of virality.
  score = Math.max(0, Math.min(exceptionalEvidence ? 96 : 89, score));
  // Scores now use a deliberately stricter, non-linear scale. Keep the
  // admission threshold aligned with it so restrained but coherent opinions
  // are still considered without inflating their displayed quality score.
  if (score < Math.max(35, config.llmThreshold - 17)) return null;

  const headline = window.find((segment) =>
    REVEAL.test(segment.text) || REACTION.test(segment.text) || CONFLICT.test(segment.text) ||
    STRONG_OPINION.test(segment.text) || ACHIEVEMENT.test(segment.text)
  )?.text ?? first;
  const titleWords = headline.replace(/\[[^\]]+\]/g, '').replace(/[^\p{L}\p{N}\s¿?¡!]/gu, '').split(/\s+/).filter(Boolean);
  const title = `${titleWords.slice(0, 9).join(' ')}${titleWords.length > 9 ? '…' : ''}`;
  return {
    title: title || 'Momento destacado',
    hookText: first.slice(0, 140),
    hookType: seed.kinds.includes('reveal') ? 'Revelación' : seed.kinds.includes('reaction') ? 'Reacción' : seed.kinds.includes('conflict') ? 'Conflicto' : seed.kinds.includes('opinion') ? 'Opinión' : seed.kinds.includes('achievement') ? 'Logro' : 'Historia',
    contextStatus: startsBadly || endsBadly ? 'partial' : 'self-contained',
    sceneChanges,
    startTime: Math.max(0, Math.round((startTime - 0.35) * 100) / 100),
    endTime: Math.round((endTime + 0.55) * 100) / 100,
    score,
    breakdown: {
      hook: Math.round(hookRatio * config.hookWeight),
      infoValue: Math.round(infoRatio * config.infoWeight),
      emotion: Math.round(emotionRatio * config.emotionWeight),
      selfContained: Math.round(selfContainedRatio * config.selfContainedWeight),
      durationFit: Math.round(paceRatio * config.durationWeight),
    },
    reason: `${seed.kinds.join(' + ')} · payoff ${Math.round(payoffRatio * 100)}% · cierre ${Math.round(closureRatio * 100)}%`,
    transcriptExcerpt: text,
  };
}

export function detectNarrativeMoments(params: {
  segments: TranscriptSegment[];
  config: ScoringConfig;
  sceneTimestamps: number[];
  audio: AudioEventAnalysis;
  maxClips?: number;
}): CandidateClip[] {
  const { segments, config, sceneTimestamps, audio } = params;
  const maxClips = Math.max(1, Math.min(10, Math.round(params.maxClips ?? 5)));
  const candidates = buildSeeds(segments, audio, sceneTimestamps)
    .map((seed) => evaluateEvent(refineBoundaries(segments, seed, audio, config), seed, audio, sceneTimestamps, config))
    .filter((candidate): candidate is CandidateClip => candidate !== null)
    .sort((a, b) => b.score - a.score);

  const selected: CandidateClip[] = [];
  for (const candidate of candidates) {
    const duplicate = selected.some((existing) => {
      const intersection = Math.max(0, Math.min(existing.endTime, candidate.endTime) - Math.max(existing.startTime, candidate.startTime));
      const union = Math.max(existing.endTime, candidate.endTime) - Math.min(existing.startTime, candidate.startTime);
      const shortest = Math.min(existing.endTime - existing.startTime, candidate.endTime - candidate.startTime);
      return (union > 0 && intersection / union >= 0.2) || (shortest > 0 && intersection / shortest >= 0.28);
    });
    const sameTypeCount = selected.filter((item) => item.hookType === candidate.hookType).length;
    const tooSimilar = sameTypeCount >= Math.max(2, Math.ceil(maxClips * 0.45));
    if (!duplicate && !tooSimilar) selected.push(candidate);
    if (selected.length >= maxClips) break;
  }
  if (selected.length < maxClips) {
    for (const candidate of candidates) {
      if (selected.includes(candidate)) continue;
      const overlaps = selected.some((existing) => {
        const intersection = Math.max(0, Math.min(existing.endTime, candidate.endTime) - Math.max(existing.startTime, candidate.startTime));
        const shortest = Math.min(existing.endTime - existing.startTime, candidate.endTime - candidate.startTime);
        return shortest > 0 && intersection / shortest >= 0.28;
      });
      if (!overlaps) selected.push(candidate);
      if (selected.length >= maxClips) break;
    }
  }
  return selected;
}

