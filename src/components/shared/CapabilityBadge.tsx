import type { ReactElement } from 'react';
import { CAPABILITIES, type CapabilityName } from '@/lib/shared/capabilities';
import { isElectron } from '@/lib/shared/platform';

interface Props {
  feature: CapabilityName;
  className?: string;
}

/**
 * Subtle inline tag rendered next to controls for features that aren't
 * available in the current target (Gap #10). Always derives state from
 * `capabilities.ts` — never hardcode a "desktop only" string elsewhere.
 */
export function CapabilityBadge({ feature, className }: Props): ReactElement | null {
  const row = CAPABILITIES[feature];
  if (!row) return null;
  const here = isElectron() ? row.desktop : row.web;
  if (here) return null;
  const other = isElectron() ? 'Web only' : 'Desktop only';
  const title = row.notes ? `${row.label} — ${row.notes}` : row.label;
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground ring-1 ring-inset ring-border ${className ?? ''}`}
      title={title}
      aria-label={`Feature unavailable: ${other}`}
    >
      {other}
    </span>
  );
}
