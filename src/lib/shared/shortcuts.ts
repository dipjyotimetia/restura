import { isMac } from './platform';

/**
 * Single source of truth for app keyboard shortcuts: the handlers in the route
 * register these combos, and the Settings shortcut sheet and command-palette
 * hints render them, so labels can't drift from bindings again.
 *
 * Combos use the `useKeybindings` grammar ('mod+k', 'alt+shift+keyt', …).
 * Physical-key tokens (keyw, digit1, bracketright) match `KeyboardEvent.code`
 * so Option/Alt combos work on macOS, where Option+W types '∑'.
 *
 * Desktop and web differ on purpose: the browser keeps ⌘W/⌘T/⌘N/Ctrl+Tab/⌘1–9
 * for itself, so the web build uses Alt-based equivalents. A null combo means
 * the shortcut isn't offered on that platform.
 */

export type ShortcutGroup = 'General' | 'Request' | 'Tabs';

export interface ShortcutDef {
  id: string;
  label: string;
  group: ShortcutGroup;
  desktop: string | null;
  web: string | null;
  /** Display-only suffix for a family of combos, e.g. '1–9' for digit1…digit9. */
  range?: string;
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  {
    id: 'palette',
    label: 'Open command palette',
    group: 'General',
    desktop: 'mod+k',
    web: 'mod+k',
  },
  {
    id: 'shortcuts',
    label: 'Show keyboard shortcuts',
    group: 'General',
    desktop: 'mod+/',
    web: 'mod+/',
  },
  { id: 'settings', label: 'Open settings', group: 'General', desktop: 'mod+,', web: 'mod+,' },
  {
    id: 'toggle-sidebar',
    label: 'Toggle sidebar',
    group: 'General',
    desktop: 'mod+b',
    web: 'mod+b',
  },
  {
    id: 'toggle-console',
    label: 'Toggle network console',
    group: 'General',
    desktop: 'mod+shift+c',
    web: 'mod+shift+c',
  },
  {
    id: 'import',
    label: 'Import collection',
    group: 'General',
    desktop: 'mod+i',
    web: null,
  },
  {
    id: 'export',
    label: 'Export collection',
    group: 'General',
    desktop: 'mod+e',
    web: null,
  },
  {
    id: 'send',
    label: 'Send request (cancels while one is in flight)',
    group: 'Request',
    desktop: 'mod+enter',
    web: 'mod+enter',
  },
  {
    id: 'save',
    label: 'Save request to collection',
    group: 'Request',
    desktop: 'mod+s',
    web: 'mod+s',
  },
  {
    id: 'sub-tab',
    label: 'Switch request section (Params … Settings)',
    group: 'Request',
    desktop: 'alt+digit1',
    web: 'alt+digit1',
    range: '1–6',
  },
  { id: 'new-tab', label: 'New request', group: 'Tabs', desktop: 'mod+n', web: 'alt+keyn' },
  { id: 'close-tab', label: 'Close tab', group: 'Tabs', desktop: 'mod+keyw', web: 'alt+keyw' },
  {
    id: 'reopen-tab',
    label: 'Reopen closed tab',
    group: 'Tabs',
    desktop: 'mod+shift+keyt',
    web: 'alt+shift+keyt',
  },
  {
    id: 'next-tab',
    label: 'Next tab',
    group: 'Tabs',
    desktop: 'mod+tab',
    web: 'alt+bracketright',
  },
  {
    id: 'prev-tab',
    label: 'Previous tab',
    group: 'Tabs',
    desktop: 'mod+shift+tab',
    web: 'alt+bracketleft',
  },
  {
    id: 'jump-tab',
    label: 'Go to tab',
    group: 'Tabs',
    desktop: 'mod+digit1',
    web: null,
    range: '1–9',
  },
];

export function shortcutCombo(id: string, electron: boolean): string | null {
  const def = SHORTCUTS.find((s) => s.id === id);
  if (!def) return null;
  return electron ? def.desktop : def.web;
}

const NAMED_KEYS: Record<string, string> = {
  enter: '↵',
  tab: 'Tab',
  bracketright: ']',
  bracketleft: '[',
};

/** Render a combo as key caps, e.g. ['⌘', '⇧', 'T'] on macOS or ['Ctrl', 'Shift', 'T']. */
export function formatCombo(combo: string, mac: boolean, range?: string): string[] {
  const parts = combo.toLowerCase().split('+');
  const keys = parts.map((part) => {
    if (part === 'mod') return mac ? '⌘' : 'Ctrl';
    if (part === 'shift') return mac ? '⇧' : 'Shift';
    if (part === 'alt') return mac ? '⌥' : 'Alt';
    if (part in NAMED_KEYS) return NAMED_KEYS[part] as string;
    const physical = /^(?:key([a-z])|digit(\d))$/.exec(part);
    if (physical) return (physical[1] ?? physical[2] ?? '').toUpperCase();
    return part.length === 1 ? part.toUpperCase() : part;
  });
  if (range) keys[keys.length - 1] = range;
  return keys;
}

/** Shortcut-sheet rows for the current platform, grouped, skipping unavailable ones. */
export function shortcutSheet(
  electron: boolean,
  mac: boolean
): Array<{ title: ShortcutGroup; shortcuts: Array<{ keys: string[]; description: string }> }> {
  const groups: ShortcutGroup[] = ['General', 'Request', 'Tabs'];
  return groups.map((title) => ({
    title,
    shortcuts: SHORTCUTS.filter((s) => s.group === title).flatMap((s) => {
      const combo = electron ? s.desktop : s.web;
      return combo ? [{ keys: formatCombo(combo, mac, s.range), description: s.label }] : [];
    }),
  }));
}

/** Inline label for a Cmd/Ctrl combo: '⌘K' on macOS, 'Ctrl+K' elsewhere. */
export function modLabel(key: string, mac: boolean = isMac()): string {
  return mac ? `⌘${key}` : `Ctrl+${key}`;
}
