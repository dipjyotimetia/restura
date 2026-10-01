import { describe, expect, it } from 'vitest';
import { subTabForShortcut } from './subTabShortcut';

const press = (code: string, key: string, mods: Partial<KeyboardEvent> = {}) =>
  subTabForShortcut({
    altKey: true,
    metaKey: false,
    ctrlKey: false,
    code,
    key,
    ...mods,
  } as KeyboardEvent);

describe('subTabForShortcut', () => {
  it('matches the physical digit key on macOS, where Option+1 types "¡"', () => {
    expect(press('Digit1', '¡')).toBe('params');
    expect(press('Digit6', '§')).toBe('settings');
  });

  it('ignores non-Alt presses and Alt combined with Cmd/Ctrl', () => {
    expect(press('Digit1', '1', { altKey: false })).toBeUndefined();
    expect(press('Digit1', '1', { metaKey: true })).toBeUndefined();
    expect(press('Digit1', '1', { ctrlKey: true })).toBeUndefined();
    expect(press('Digit7', '7')).toBeUndefined();
  });
});
