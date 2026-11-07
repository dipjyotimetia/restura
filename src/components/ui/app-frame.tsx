import { type ReactNode, useState } from 'react';

/** id of the focus target the skip link jumps to (each route's `<main>`). */
export const MAIN_CONTENT_ID = 'main-content';

/**
 * Keyboard "skip to main content" link — visually hidden until focused. Moves
 * focus programmatically rather than following `href="#main-content"`, which
 * would replace the hash route (`#/…`).
 */
export function SkipToMainLink() {
  // Visibility follows React focus state rather than `focus:` utilities: the
  // global unlayered `.sr-only` / utility cascade otherwise keeps it hidden.
  const [focused, setFocused] = useState(false);
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onClick={(e) => {
        e.preventDefault();
        const target = document.getElementById(MAIN_CONTENT_ID);
        target?.focus();
      }}
      data-visible={focused || undefined}
      className={
        focused
          ? 'fixed left-3 top-3 z-[100] rounded-sp-btn border border-sp-line-strong bg-sp-surface-hi px-3 py-2 text-sp-12 text-sp-text outline-none ring-2 ring-sp-accent'
          : 'sr-only'
      }
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
