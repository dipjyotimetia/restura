export type SubTabKey = 'params' | 'headers' | 'body' | 'auth' | 'scripts' | 'settings';

// Keyed by KeyboardEvent.code: on macOS, Option+1 produces e.key === '¡', so
// matching on e.key never fires there.
const TAB_KEYS: Record<string, SubTabKey> = {
  Digit1: 'params',
  Digit2: 'headers',
  Digit3: 'body',
  Digit4: 'auth',
  Digit5: 'scripts',
  Digit6: 'settings',
};

/** Sub-tab for an Alt+1..6 keypress, or undefined when it isn't one. */
export function subTabForShortcut(
  e: Pick<KeyboardEvent, 'altKey' | 'metaKey' | 'ctrlKey' | 'code'>
): SubTabKey | undefined {
  if (!e.altKey || e.metaKey || e.ctrlKey) return undefined;
  return TAB_KEYS[e.code];
}
