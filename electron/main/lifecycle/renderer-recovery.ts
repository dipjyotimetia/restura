/**
 * What to do when a renderer process exits. `clean-exit` is a normal
 * navigation away. The first crash reloads the window; a second one stops
 * so a broken page cannot reload forever.
 */
export type RendererGoneAction = 'ignore' | 'reload' | 'give-up';

export function rendererGoneAction(reloadsAlready: number, reason: string): RendererGoneAction {
  if (reason === 'clean-exit') return 'ignore';
  if (reloadsAlready >= 1) return 'give-up';
  return 'reload';
}
