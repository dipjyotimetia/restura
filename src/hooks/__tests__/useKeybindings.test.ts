import { describe, expect, it } from 'vitest';
import { __test } from '../useKeybindings';

const { comboMatches, isEditableTarget } = __test;

function key(init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', init);
}

describe('comboMatches', () => {
  it('matches mod+key with meta or ctrl', () => {
    expect(comboMatches('mod+s', key({ key: 's', metaKey: true }))).toBe(true);
    expect(comboMatches('mod+s', key({ key: 's', ctrlKey: true }))).toBe(true);
    expect(comboMatches('mod+s', key({ key: 's' }))).toBe(false);
  });

  it('is case-insensitive on the key', () => {
    expect(comboMatches('mod+k', key({ key: 'K', metaKey: true }))).toBe(true);
  });

  it('requires shift when specified', () => {
    expect(comboMatches('mod+shift+c', key({ key: 'c', metaKey: true, shiftKey: true }))).toBe(
      true
    );
    expect(comboMatches('mod+shift+c', key({ key: 'c', metaKey: true }))).toBe(false);
  });

  it('tolerates an extra shift on combos that do not specify it (layout punctuation)', () => {
    // On layouts where '/' or ',' need Shift, the combo must still fire.
    expect(comboMatches('mod+/', key({ key: '/', metaKey: true, shiftKey: true }))).toBe(true);
    expect(comboMatches('mod+s', key({ key: 's', metaKey: true, shiftKey: true }))).toBe(true);
  });

  it('handles punctuation keys', () => {
    expect(comboMatches('mod+,', key({ key: ',', metaKey: true }))).toBe(true);
    expect(comboMatches('mod+/', key({ key: '/', metaKey: true }))).toBe(true);
  });
});

describe('comboMatches physical keys', () => {
  it('matches Option/Alt combos by code even when the key is a symbol (macOS)', () => {
    expect(comboMatches('alt+keyw', key({ key: '∑', code: 'KeyW', altKey: true }))).toBe(true);
    expect(
      comboMatches('alt+bracketright', key({ key: '‘', code: 'BracketRight', altKey: true }))
    ).toBe(true);
    expect(comboMatches('mod+digit3', key({ key: '3', code: 'Digit3', metaKey: true }))).toBe(true);
    expect(comboMatches('alt+keyw', key({ key: 'w', code: 'KeyQ', altKey: true }))).toBe(false);
  });

  it('does not treat AltGr (Ctrl+Alt on Windows) as a Ctrl+digit shortcut', () => {
    expect(
      comboMatches('mod+digit8', key({ key: '[', code: 'Digit8', ctrlKey: true, altKey: true }))
    ).toBe(false);
  });

  it('ctrl requires the literal Control key, even on macOS', () => {
    expect(comboMatches('ctrl+tab', key({ key: 'Tab', ctrlKey: true }))).toBe(true);
    expect(comboMatches('ctrl+tab', key({ key: 'Tab', metaKey: true }))).toBe(false);
    expect(comboMatches('ctrl+shift+tab', key({ key: 'Tab', ctrlKey: true }))).toBe(false);
  });
});

describe('isEditableTarget', () => {
  it('detects inputs, textareas, selects', () => {
    expect(isEditableTarget(document.createElement('input'))).toBe(true);
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    expect(isEditableTarget(document.createElement('select'))).toBe(true);
  });

  it('returns false for non-editable elements', () => {
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it('detects contenteditable', () => {
    const el = document.createElement('div');
    el.contentEditable = 'true';
    // jsdom doesn't compute isContentEditable from the attribute; assert the
    // attribute path indirectly via a spy-free manual flag.
    Object.defineProperty(el, 'isContentEditable', { value: true });
    expect(isEditableTarget(el)).toBe(true);
  });
});
