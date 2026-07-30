import { Apple, ChevronDown, Download, Monitor, Terminal } from 'lucide-react';
import type { ReactElement } from 'react';
import { isElectron } from '@/lib/shared/platform';
import { cn } from '@/lib/shared/utils';

const releaseUrl = 'https://github.com/dipjyotimetia/restura/releases/latest';

const platforms = [
  { label: 'macOS', icon: Apple },
  { label: 'Windows', icon: Monitor },
  { label: 'Linux', icon: Terminal },
] as const;

export function WebNativeDownloadBanner(): ReactElement | null {
  if (isElectron()) return null;

  return (
    <aside
      aria-label="Native app download"
      className="shrink-0 border-b border-sky-500/20 bg-sky-500/5 px-4 py-2 text-sp-12 text-sp-muted dark:bg-sky-950/20"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
        <Download className="size-3.5 shrink-0 text-sky-500 dark:text-sky-300" aria-hidden="true" />
        <span>
          Prefer native? Get desktop-only networking, certificates, and local integrations.
        </span>
        <details className="group relative">
          <summary
            className={cn(
              'flex cursor-pointer list-none items-center gap-1 rounded-sp-btn border border-sky-500/25',
              'bg-sky-500/10 px-2 py-1 font-medium text-sky-700 transition hover:bg-sky-500/15',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
              'dark:text-sky-200'
            )}
          >
            Download native app
            <ChevronDown
              className="size-3 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <div className="absolute right-0 z-50 mt-2 grid min-w-45 gap-1 rounded-sp-panel border border-sp-line bg-sp-surface-hi p-1.5 shadow-lg">
            {platforms.map(({ label, icon: Icon }) => (
              <a
                key={label}
                href={releaseUrl}
                className="flex items-center gap-2 rounded-sp-btn px-2.5 py-2 text-sp-12 font-medium text-sp-text transition hover:bg-sp-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
              >
                <Icon className="size-4 text-sp-muted" aria-hidden="true" />
                <span>Download for {label}</span>
              </a>
            ))}
          </div>
        </details>
      </div>
    </aside>
  );
}
