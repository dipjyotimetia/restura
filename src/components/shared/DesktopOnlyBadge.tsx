'use client';

import { isElectron } from '@/lib/shared/platform';

const DEFAULT_TITLE =
  'This feature is only available in the Electron desktop app. The web client cannot present client certificates, override the system trust store, tunnel through SOCKS, or disable TLS verification — these are restricted by the browser sandbox.';

/** Tooltip for a protocol/action that only the desktop app can run. */
export const DESKTOP_ONLY_ACTION_TITLE =
  'Desktop only — needs the Restura desktop app (the browser cannot open raw TCP connections).';

/**
 * Props for a control that is unavailable on this platform but should stay
 * discoverable: `aria-disabled` instead of `disabled`, so it remains focusable
 * and hoverable and its tooltip (and any `DesktopOnlyBadge` inside) can show —
 * a natively disabled button gets `pointer-events: none`. Callers must also
 * make the click a no-op when `gated`.
 */
export function desktopOnlyGateProps(
  gated: boolean,
  title: string = DESKTOP_ONLY_ACTION_TITLE
): { 'aria-disabled'?: true; title?: string } {
  return gated ? { 'aria-disabled': true, title } : {};
}

/** Disabled look for an `aria-disabled` (still focusable) control. */
export const ARIA_DISABLED_CLASSES = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

interface DesktopOnlyBadgeProps {
  /** Optional override for the tooltip text. */
  title?: string;
  /** Extra Tailwind classes appended to the default styling. */
  className?: string;
}

/**
 * Small inline badge that surfaces "Desktop only" next to a settings field
 * whose underlying capability isn't available in the web/PWA client.
 *
 * Renders nothing inside Electron — desktop users don't need the hint.
 *
 * Used to flag mTLS, custom CA, SOCKS proxy types, and "Verify SSL" toggles.
 */
export function DesktopOnlyBadge({ title = DEFAULT_TITLE, className }: DesktopOnlyBadgeProps) {
  if (isElectron()) return null;
  return (
    <span
      className={
        'ml-2 inline-flex items-center rounded bg-amber-100 dark:bg-amber-950/40 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300' +
        (className ? ` ${className}` : '')
      }
      title={title}
      role="note"
      aria-label="Desktop only feature"
    >
      Desktop only
    </span>
  );
}
