import React, { useState } from 'react';
import {
  CheckCircle2,
  Database,
  HardDrive,
  Moon,
  Sun,
  Trash2,
  XCircle,
} from 'lucide-react';
import { TRANSLATIONS, type Language } from '../i18n';
import type { SystemStatus } from '../types';
import { formatBytes } from '../utils/format';
import { LanguageSwitch } from './LanguageSwitch';

interface PipelineViewProps {
  status: SystemStatus | null;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onCleanupStorage: () => Promise<void>;
  lang: Language;
  onChangeLang: (lang: Language) => void;
}

export const PipelineView: React.FC<PipelineViewProps> = ({
  status,
  theme,
  onToggleTheme,
  onCleanupStorage,
  lang,
  onChangeLang,
}) => {
  const t = TRANSLATIONS[lang].pipeline;
  const [cleaning, setCleaning] = useState(false);

  const handleClean = async () => {
    setCleaning(true);
    try {
      await onCleanupStorage();
    } finally {
      setCleaning(false);
    }
  };

  return (
    <main className="mx-auto max-w-[1440px] px-6 py-8 space-y-8">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
            {t.title}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">{t.subtitle}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <LanguageSwitch lang={lang} onChangeLang={onChangeLang} />
          <button
            type="button"
            onClick={onToggleTheme}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:bg-[#111318] dark:text-slate-200 dark:hover:bg-white/5 whitespace-nowrap shrink-0"
          >
            {theme === 'dark' ? (
              <Sun className="h-4 w-4 text-amber-400" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
            <span>{theme === 'dark' ? t.switchToLight : t.switchToDark}</span>
          </button>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-white/10 dark:bg-[#111318]">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {t.ffmpegTitle}
          </div>
          <div className="mt-2 flex items-center gap-2">
            {status?.ffmpegAvailable && status?.ffprobeAvailable ? (
              <>
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                <span className="font-display text-base font-semibold text-slate-900 dark:text-white">
                  {t.installedReady}
                </span>
              </>
            ) : (
              <>
                <XCircle className="h-5 w-5 text-red-500" />
                <span className="font-display text-base font-semibold text-slate-900 dark:text-white">
                  {t.unavailable}
                </span>
              </>
            )}
          </div>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{t.ffmpegDesc}</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-white/10 dark:bg-[#111318]">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {t.geminiTitle}
          </div>
          <div className="mt-2 flex items-center gap-2">
            {status?.geminiConfigured ? (
              <>
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                <span className="font-display text-base font-semibold text-slate-900 dark:text-white">
                  {t.serverKeyActive}
                </span>
              </>
            ) : (
              <>
                <XCircle className="h-5 w-5 text-amber-500" />
                <span className="font-display text-base font-semibold text-slate-900 dark:text-white">
                  {t.heuristicMode}
                </span>
              </>
            )}
          </div>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{t.geminiDesc}</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-white/10 dark:bg-[#111318]">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {t.storageTitle}
            </span>
            <HardDrive className="h-4 w-4 text-slate-400" />
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold text-slate-900 dark:text-white tabular-nums">
            {formatBytes(status?.storageBytes ?? 0)}
          </div>
          <div className="mt-3">
            <button
              type="button"
              disabled={cleaning}
              onClick={handleClean}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/5"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>{t.cleanTemp}</span>
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111318]">
        <div className="flex items-center gap-2 border-b border-slate-200 px-6 py-4 dark:border-white/10">
          <Database className="h-4 w-4 text-emerald-500" />
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white">
            {t.dbTitle}
          </h2>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs text-slate-500 dark:border-white/10 dark:text-slate-400">
              <tr>
                <th className="px-6 py-3 font-medium">{t.colTable}</th>
                <th className="px-6 py-3 font-medium">{t.colResp}</th>
                <th className="px-6 py-3 font-medium text-right">{t.colRecords}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/5 text-xs">
              {[
                { name: 'users', desc: t.tables.users, count: status?.tableCounts.users ?? 0 },
                { name: 'projects', desc: t.tables.projects, count: status?.tableCounts.projects ?? 0 },
                { name: 'videos', desc: t.tables.videos, count: status?.tableCounts.videos ?? 0 },
                {
                  name: 'transcriptions',
                  desc: t.tables.transcriptions,
                  count: status?.tableCounts.transcriptions ?? 0,
                },
                { name: 'clips', desc: t.tables.clips, count: status?.tableCounts.clips ?? 0 },
                {
                  name: 'processing_jobs',
                  desc: t.tables.processing_jobs,
                  count: status?.tableCounts.processingJobs ?? 0,
                },
              ].map((row) => (
                <tr key={row.name} className="hover:bg-slate-50 dark:hover:bg-white/[0.02]">
                  <td className="px-6 py-3 font-mono font-semibold text-slate-900 dark:text-white">
                    {row.name}
                  </td>
                  <td className="px-6 py-3 text-slate-600 dark:text-slate-400">{row.desc}</td>
                  <td className="px-6 py-3 text-right font-mono font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
                    {row.count}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
};
