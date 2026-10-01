import { describe, expect, it } from 'vitest';
import { formatCombo, SHORTCUTS, shortcutCombo, shortcutSheet } from './shortcuts';

describe('formatCombo', () => {
  it('renders macOS symbols and spelled-out keys elsewhere', () => {
    expect(formatCombo('mod+shift+keyt', true)).toEqual(['⌘', '⇧', 'T']);
    expect(formatCombo('mod+shift+keyt', false)).toEqual(['Ctrl', 'Shift', 'T']);
    expect(formatCombo('alt+bracketright', true)).toEqual(['⌥', ']']);
    expect(formatCombo('alt+bracketleft', false)).toEqual(['Alt', '[']);
    expect(formatCombo('mod+enter', true)).toEqual(['⌘', '↵']);
    expect(formatCombo('mod+tab', false)).toEqual(['Ctrl', 'Tab']);
    expect(formatCombo('mod+,', true)).toEqual(['⌘', ',']);
    expect(formatCombo('alt+digit1', true, '1–6')).toEqual(['⌥', '1–6']);
  });
});

describe('shortcut registry', () => {
  it('has unique ids and never binds browser-reserved keys on web', () => {
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length);
    const reserved = ['mod+keyw', 'mod+n', 'mod+shift+keyt', 'mod+tab', 'mod+digit1'];
    for (const s of SHORTCUTS) expect(reserved).not.toContain(s.web);
  });

  it('looks up combos per platform', () => {
    expect(shortcutCombo('close-tab', true)).toBe('mod+keyw');
    expect(shortcutCombo('close-tab', false)).toBe('alt+keyw');
    expect(shortcutCombo('jump-tab', false)).toBeNull();
    expect(shortcutCombo('nope', true)).toBeNull();
  });

  it('builds a sheet that omits shortcuts unavailable on the platform', () => {
    const web = shortcutSheet(false, false).flatMap((g) => g.shortcuts.map((s) => s.description));
    expect(web).not.toContain('Go to tab');
    expect(web).not.toContain('Import collection');
    const desktop = shortcutSheet(true, true);
    const tabs = desktop.find((g) => g.title === 'Tabs')?.shortcuts ?? [];
    expect(tabs.find((s) => s.description === 'Go to tab')?.keys).toEqual(['⌘', '1–9']);
  });
});
