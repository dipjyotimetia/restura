import {
  Bot,
  Database,
  Download,
  Info,
  Keyboard as KeyboardIcon,
  KeyRound,
  Network,
  Palette,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Sparkles,
} from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/shared/utils';
import type { SectionId, SettingsSectionDefinition } from '../types';

export const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = [
  {
    id: 'general',
    label: 'General',
    icon: Sliders,
    keywords: ['theme', 'layout', 'orientation', 'history', 'telemetry', 'crash', 'privacy'],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: Palette,
    keywords: ['accent', 'color', 'colour', 'theme', 'dark', 'light'],
  },
  {
    id: 'requests',
    label: 'Requests',
    icon: Send,
    keywords: ['timeout', 'redirects', 'ssl', 'tls', 'verify', 'cookies'],
  },
  { id: 'proxy', label: 'Proxy', icon: Network, keywords: ['socks', 'http proxy', 'pac'] },
  {
    id: 'certificates',
    label: 'Certificates',
    icon: ShieldCheck,
    keywords: ['mtls', 'client certificate', 'ca', 'tls'],
  },
  { id: 'security', label: 'Security', icon: ShieldAlert, keywords: ['sandbox', 'scripts'] },
  { id: 'secrets', label: 'Secrets', icon: KeyRound, keywords: ['vault', 'keychain', 'password'] },
  { id: 'ai', label: 'AI', icon: Sparkles, keywords: ['assistant', 'provider', 'model', 'judge'] },
  { id: 'mcp', label: 'MCP Server', icon: Bot, keywords: ['model context protocol', 'tools'] },
  {
    id: 'data',
    label: 'Data',
    icon: Database,
    keywords: ['export', 'import', 'backup', 'clear', 'capture'],
  },
  { id: 'updates', label: 'Updates', icon: Download, keywords: ['version', 'release'] },
  { id: 'shortcuts', label: 'Shortcuts', icon: KeyboardIcon, keywords: ['keyboard', 'keys'] },
  { id: 'about', label: 'About', icon: Info, keywords: ['version', 'license', 'desktop app'] },
];

/** Sections whose label or keywords contain the query (case-insensitive). */
export function filterSettingsSections(
  query: string,
  sections: readonly SettingsSectionDefinition[] = SETTINGS_SECTIONS
): SettingsSectionDefinition[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...sections];
  return sections.filter(
    (s) => s.label.toLowerCase().includes(q) || (s.keywords ?? []).some((k) => k.includes(q))
  );
}

interface SettingsNavigationProps {
  activeSection: SectionId;
  onSectionChange: (section: SectionId) => void;
}

export function SettingsNavigation({ activeSection, onSectionChange }: SettingsNavigationProps) {
  const [query, setQuery] = useState('');
  const visible = filterSettingsSections(query);
  return (
    <>
      {/* Narrow drawers (< 640px) swap the side nav for a compact picker. */}
      <div className="sm:hidden shrink-0 border-b border-sp-line px-4 py-2">
        <select
          aria-label="Settings section"
          value={activeSection}
          onChange={(e) => onSectionChange(e.target.value as SectionId)}
          className="w-full rounded-sp-btn border border-sp-line bg-sp-surface-lo px-2 py-1.5 text-sp-13 text-sp-text focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
        >
          {SETTINGS_SECTIONS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <nav
        aria-label="Settings sections"
        className="max-sm:hidden w-[220px] shrink-0 border-r border-sp-line py-4 px-2 overflow-y-auto flex flex-col gap-0.5"
      >
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter jumps to the first match.
            if (e.key === 'Enter' && visible[0]) onSectionChange(visible[0].id);
          }}
          aria-label="Filter settings"
          placeholder="Filter settings…"
          className="mx-1 mb-2 rounded-sp-btn border border-sp-line bg-sp-surface-lo px-2.5 py-1.5 text-sp-12 text-sp-text placeholder:text-sp-dim focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
        />
        {visible.length === 0 && (
          <p className="px-3 py-2 text-sp-12 text-sp-muted">No matching settings</p>
        )}
        {visible.map((section) => {
          const Icon = section.icon;
          const isActive = activeSection === section.id;

          return (
            <button
              key={section.id}
              type="button"
              onClick={() => onSectionChange(section.id)}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'relative flex items-center gap-2.5 w-full text-left rounded-sp-btn',
                'text-sp-13 transition-all duration-150',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
                isActive
                  ? 'bg-sp-active text-sp-text font-semibold'
                  : 'text-sp-muted hover:text-sp-text hover:bg-sp-hover'
              )}
              style={{ padding: '9px 12px 9px 14px' }}
            >
              {isActive && (
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-sp-accent"
                  style={{ boxShadow: '0 0 8px var(--sp-accent-glow-55)' }}
                />
              )}
              <Icon
                size={14}
                className={cn('transition-colors', isActive ? 'text-sp-accent' : 'text-sp-muted')}
              />
              <span>{section.label}</span>
            </button>
          );
        })}
      </nav>
    </>
  );
}
