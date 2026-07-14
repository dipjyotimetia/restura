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
