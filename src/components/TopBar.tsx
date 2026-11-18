import React from 'react';
import { Plus } from 'lucide-react';
import { TRANSLATIONS, type Language } from '../i18n';

export type NavTab = 'projects' | 'studio' | 'scoring' | 'pipeline';

interface TopBarProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  onOpenUpload: () => void;
  lang: Language;
}

export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  onSelectTab,
  onOpenUpload,
  lang,
}) => {
  const t = TRANSLATIONS[lang].nav;
  const navItems: Array<{ id: NavTab; label: string }> = [
    { id: 'projects', label: t.projects },
    { id: 'studio', label: t.studio },
    { id: 'scoring', label: t.scoring },
    { id: 'pipeline', label: t.pipeline },
  ];

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur dark:border-white/10 dark:bg-[#0A0B0E]/95">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between gap-8 px-6">
        {/* Zone 1: Single text element wordmark */}
        <button
          type="button"
          onClick={() => onSelectTab('projects')}
          className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-md"
        >
          ClipForge
        </button>

        {/* Zone 2: 4 concise single-line text navigation links */}
        <nav className="flex h-16 items-center gap-4 sm:gap-6">
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`relative flex h-full items-center text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-sm ${
                  isActive
                    ? 'text-slate-900 dark:text-white'
                    : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                }`}
              >
                <span>{item.label}</span>
                {isActive && (
                  <span className="absolute inset-x-0 bottom-0 h-0.5 bg-emerald-500" />
                )}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: 1 primary CTA */}
        <div className="shrink-0">
          <button
            type="button"
            onClick={onOpenUpload}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition-colors hover:bg-emerald-400 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            <Plus className="h-4 w-4" />
            <span>{t.uploadVideo}</span>
          </button>
        </div>
      </div>
    </header>
  );
};
