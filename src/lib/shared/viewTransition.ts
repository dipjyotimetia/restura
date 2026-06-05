import { flushSync } from 'react-dom';

type StartViewTransition = (callback: () => void) => { finished: Promise<void> };

/**
 * Run a DOM-mutating React update inside a View Transition so the change
 * cross-fades instead of snapping. Used for the light/dark theme switch.
 *
 * Degrades gracefully: where the View Transitions API is unavailable
 * (e.g. Firefox) or the user prefers reduced motion, the update runs plainly.
 * `flushSync` forces the React update to land synchronously so the transition
 * captures the post-update DOM.
 */
export function withViewTransition(update: () => void): void {
  const doc = document as Document & { startViewTransition?: StartViewTransition };
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  if (typeof doc.startViewTransition !== 'function' || prefersReducedMotion) {
    update();
    return;
  }

  doc.startViewTransition(() => flushSync(update));
}
