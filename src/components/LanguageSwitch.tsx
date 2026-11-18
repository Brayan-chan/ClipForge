import React from 'react';
import { Globe } from 'lucide-react';
import type { Language } from '../i18n';

interface LanguageSwitchProps {
  lang: Language;
  onChangeLang: (lang: Language) => void;
}

export const LanguageSwitch: React.FC<LanguageSwitchProps> = ({
  lang,
  onChangeLang,
}) => {
  return (
    <div
      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-100 p-1 dark:border-white/10 dark:bg-[#111318]"
      role="group"
      aria-label="Language selector"
    >
      <Globe className="ml-1.5 mr-0.5 h-3.5 w-3.5 text-slate-400" />
      {(['es', 'en'] as Language[]).map((code) => {
        const active = lang === code;
        return (
          <button
            key={code}
            type="button"
            onClick={() => onChangeLang(code)}
            className={`rounded-md px-2.5 py-1 text-xs font-semibold uppercase transition-colors whitespace-nowrap shrink-0 ${
              active
                ? 'bg-white text-slate-900 shadow-sm dark:bg-[#252A36] dark:text-white'
                : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
            }`}
          >
            {code}
          </button>
        );
      })}
    </div>
  );
};
