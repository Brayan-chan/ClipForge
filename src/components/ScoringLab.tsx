import React, { useState } from 'react';
import { CheckCircle2, Play, RotateCcw, Save } from 'lucide-react';
import { TRANSLATIONS, type Language } from '../i18n';
import type { ClipScoreBreakdown, ContextStatus, ScoringConfig, TranscriptSegment } from '../types';
import { formatTimecode } from '../utils/format';
import { LanguageSwitch } from './LanguageSwitch';

interface ScoringLabProps {
  config: ScoringConfig;
  onSaveConfig: (next: ScoringConfig) => Promise<void>;
  lang: Language;
  onChangeLang: (lang: Language) => void;
}

interface LabCandidate {
  title: string;
  hookText: string;
  hookType?: string;
  contextStatus?: ContextStatus;
  sceneChanges?: number;
  startTime: number;
  endTime: number;
  score: number;
  breakdown: ClipScoreBreakdown;
  reason: string;
}

const DEFAULT_TEST_TRANSCRIPTS: Record<Language, string> = {
  es: `[00:00] Mucha gente piensa que crear un SaaS de clipping requiere cinco agentes de IA conversando.
[00:07] Pero la clave real está en combinar FFmpeg con una rúbrica determinista de 100 puntos.
[00:14] Por qué fracasan muchos prototipos? Porque envían horas de texto sin filtrar al LLM y queman presupuesto.
[00:22] Si primero puntuamos gancho, valor informativo y emoción localmente, ahorramos hasta 80% en tokens.
[00:30] Paso final: solo los segmentos arriba del umbral pasan al modelo para devolver JSON limpio.`,
  en: `[00:00] Most people think building a clipping SaaS requires five autonomous AI agents talking together.
[00:07] The real secret is combining FFmpeg with a 100-point deterministic scoring rubric.
[00:14] Why do expensive prototypes fail? Because they send hours of unfiltered text to the LLM.
[00:22] If we score hooks, informational value, and emotion locally first, we cut token spend by 80%.
[00:30] Final step: only segments above the threshold are sent to the model for clean JSON output.`,
};

export const ScoringLab: React.FC<ScoringLabProps> = ({
  config,
  onSaveConfig,
  lang,
  onChangeLang,
}) => {
  const t = TRANSLATIONS[lang].scoring;
  const tc = TRANSLATIONS[lang].common;

  const [draft, setDraft] = useState<ScoringConfig>(config);
  const [testText, setTestText] = useState(DEFAULT_TEST_TRANSCRIPTS[lang]);
  const [results, setResults] = useState<LabCandidate[]>([]);
  const [segmentsCount, setSegmentsCount] = useState<number | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [savedMsg, setSavedMsg] = useState(false);

  const totalWeight =
    draft.hookWeight +
    draft.infoWeight +
    draft.emotionWeight +
    draft.selfContainedWeight +
    draft.durationWeight;

  const handleSave = async () => {
    await onSaveConfig(draft);
    setSavedMsg(true);
    setTimeout(() => setSavedMsg(false), 2500);
  };

  const handleReset = () => {
    setDraft({
      hookWeight: 25,
      infoWeight: 25,
      emotionWeight: 20,
      selfContainedWeight: 20,
      durationWeight: 10,
      llmThreshold: 55,
      minClipSeconds: 12,
      maxClipSeconds: 60,
    });
  };

  const handleTest = async () => {
    setIsTesting(true);
    try {
      const res = await fetch('/api/scoring-lab/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: testText, config: draft }),
      });
      const data = (await res.json()) as {
        segments?: TranscriptSegment[];
        candidates?: LabCandidate[];
      };
      setSegmentsCount(data.segments?.length ?? 0);
      setResults(data.candidates ?? []);
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <main className="mx-auto max-w-[1440px] px-6 py-8 space-y-8">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl space-y-1.5">
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
            {t.title}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">{t.subtitle}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <LanguageSwitch lang={lang} onChangeLang={onChangeLang} />
          <button
            type="button"
            onClick={handleReset}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:text-slate-200 dark:hover:bg-white/5"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>{t.resetDefaults}</span>
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400"
          >
            {savedMsg ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
            <span>{savedMsg ? tc.saved : t.saveRubric}</span>
          </button>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <section className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-6 dark:border-white/10 dark:bg-[#111318] space-y-5">
          <div className="flex items-baseline justify-between border-b border-slate-200 pb-3 dark:border-white/10">
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white">
              {t.weightsTitle}
            </h2>
            <span className="font-mono text-sm font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
              {t.total}: {totalWeight} {t.pts}
            </span>
          </div>

          <div className="space-y-4">
            {[
              { key: 'hookWeight' as const, label: t.critHook, max: 40 },
              { key: 'infoWeight' as const, label: t.critInfo, max: 40 },
              { key: 'emotionWeight' as const, label: t.critEmotion, max: 40 },
              { key: 'selfContainedWeight' as const, label: t.critSelf, max: 40 },
              { key: 'durationWeight' as const, label: t.critDuration, max: 25 },
            ].map((item) => (
              <div key={item.key} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    {item.label}
                  </span>
                  <span className="font-mono font-semibold text-slate-900 dark:text-white tabular-nums">
                    {draft[item.key]} {t.pts}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={item.max}
                  value={draft[item.key]}
                  onChange={(e) => setDraft({ ...draft, [item.key]: Number(e.target.value) })}
                  className="w-full accent-emerald-500"
                />
              </div>
            ))}
          </div>

          <div className="space-y-4 border-t border-slate-200 pt-4 dark:border-white/10">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="font-medium text-slate-700 dark:text-slate-300">
                  {t.llmThreshold}
                </span>
                <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
                  {draft.llmThreshold}/100
                </span>
              </div>
              <input
                type="range"
                min={20}
                max={90}
                value={draft.llmThreshold}
                onChange={(e) => setDraft({ ...draft, llmThreshold: Number(e.target.value) })}
                className="w-full accent-emerald-500"
              />
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t.llmThresholdHelp}</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
                  {t.minClip}
                </label>
                <input
                  type="number"
                  min={5}
                  max={45}
                  value={draft.minClipSeconds}
                  onChange={(e) => setDraft({ ...draft, minClipSeconds: Number(e.target.value) })}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 font-mono text-sm text-slate-900 dark:border-white/10 dark:bg-[#181B22] dark:text-white tabular-nums"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
                  {t.maxClip}
                </label>
                <input
                  type="number"
                  min={15}
                  max={120}
                  value={draft.maxClipSeconds}
                  onChange={(e) => setDraft({ ...draft, maxClipSeconds: Number(e.target.value) })}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 font-mono text-sm text-slate-900 dark:border-white/10 dark:bg-[#181B22] dark:text-white tabular-nums"
                />
              </div>
            </div>
          </div>
        </section>

        <section className="lg:col-span-7 rounded-xl border border-slate-200 bg-white p-6 dark:border-white/10 dark:bg-[#111318] space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white">
              {t.testerTitle}
            </h2>
            <button
              type="button"
              disabled={isTesting}
              onClick={handleTest}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              <span>{t.runScorer}</span>
            </button>
          </div>

          <textarea
            rows={7}
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-white/10 dark:bg-[#181B22] dark:text-slate-100"
          />

          <div className="space-y-3 border-t border-slate-200 pt-4 dark:border-white/10">
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span>
                {segmentsCount !== null
                  ? `${segmentsCount} ${t.segmentsLabel} · ${results.length} ${t.candidatesLabel}`
                  : t.testerIdle}
              </span>
            </div>

            {results.map((cand, idx) => {
              const passesGate = cand.score >= draft.llmThreshold;
              return (
                <div
                  key={`${cand.startTime}-${idx}`}
                  className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 dark:border-white/10 dark:bg-[#181B22]"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-sm font-semibold text-slate-900 dark:text-white">
                        {cand.title}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                        <span>
                          {formatTimecode(cand.startTime)} → {formatTimecode(cand.endTime)}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{cand.hookType || 'Standard Opener'}</span>
                        <span aria-hidden="true">·</span>
                        <span
                          className={
                            cand.contextStatus === 'needs-context'
                              ? 'text-red-500 dark:text-red-400'
                              : cand.contextStatus === 'partial'
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-emerald-600 dark:text-emerald-400'
                          }
                        >
                          {t.contextValues[cand.contextStatus ?? 'self-contained']}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{passesGate ? t.passesGate : t.filteredLocally}</span>
                      </div>
                    </div>
                    <div className="font-mono text-lg font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                      {cand.score}/100
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">{cand.reason}</p>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
};
