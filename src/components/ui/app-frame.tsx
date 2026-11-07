import type { ReactNode } from 'react';

/** id of the focus target the skip link jumps to (each route's `<main>`). */
export const MAIN_CONTENT_ID = 'main-content';

/**
 * Keyboard "skip to main content" link — visually hidden until focused. Moves
 * focus programmatically rather than following `href="#main-content"`, which
 * would replace the hash route (`#/…`).
 */
export function SkipToMainLink() {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      onClick={(e) => {
        e.preventDefault();
        const target = document.getElementById(MAIN_CONTENT_ID);
        target?.focus();
      }}
      className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-sp-btn focus:border focus:border-sp-line-strong focus:bg-sp-surface-hi focus:px-3 focus:py-2 focus:text-sp-12 focus:text-sp-text focus:outline-none focus:ring-2 focus:ring-sp-accent"
    >
      Skip to main content
    </a>
  );
}

/**
 * The window's single viewport-height column: app-wide banners (update,
 * keychain) sit in a slot at the top and take real layout space, and the
 * routed app fills what remains — so a banner never pushes the status bar
 * below the fold or makes the page scroll.
 */
export function AppFrame({ banners, children }: { banners: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <SkipToMainLink />
      <div className="shrink-0">{banners}</div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
    </div>
  );
}
