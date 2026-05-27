import { useEffect, useRef } from 'react';

/**
 * Central keyboard-shortcut registry. Replaces ad-hoc `window.addEventListener`
 * blocks scattered across components so combos live in one place and share a
 * single listener + consistent input-focus scoping.
 *
 * `combo` grammar: parts joined by '+', case-insensitive. `mod` = ⌘ on macOS /
 * Ctrl elsewhere. Examples: 'mod+s', 'mod+shift+c', 'mod+,', 'mod+/'.
 */
export interface Keybinding {
  combo: string;
  handler: (e: KeyboardEvent) => void;
  /** Skip this binding when false (lets callers gate on state). Default true. */
  enabled?: boolean;
  /**
   * Fire even when focus is in an <input>/<textarea>/contenteditable. Default
   * false — important for future single-key shortcuts. App-level combos that
   * should work while typing (save, toggle sidebar) set this true.
   */
  allowInInput?: boolean;
  /** preventDefault on match. Default true. */
  preventDefault?: boolean;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable === true
  );
}

function comboMatches(combo: string, e: KeyboardEvent): boolean {
  const parts = combo.toLowerCase().split('+');
  const key = parts[parts.length - 1] ?? '';
  const needMod = parts.includes('mod');
  const needShift = parts.includes('shift');
  const needAlt = parts.includes('alt');
  const hasMod = e.metaKey || e.ctrlKey;
  if (needMod !== hasMod) return false;
  if (needShift !== e.shiftKey) return false;
  if (needAlt !== e.altKey) return false;
  return e.key.toLowerCase() === key;
}

export function useKeybindings(bindings: Keybinding[]): void {
  // Latest-bindings ref so handlers see current closures without re-binding
  // the listener (the array identity changes every render).
  const ref = useRef(bindings);
  ref.current = bindings;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      for (const b of ref.current) {
        if (b.enabled === false) continue;
        if (!comboMatches(b.combo, e)) continue;
        if (!b.allowInInput && isEditableTarget(e.target)) continue;
        if (b.preventDefault !== false) e.preventDefault();
        b.handler(e);
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

// Exported for unit testing.
export const __test = { comboMatches, isEditableTarget };
