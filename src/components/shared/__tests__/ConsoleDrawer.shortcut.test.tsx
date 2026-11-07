import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/shared/platform', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, isElectron: vi.fn(() => false) };
});
vi.mock('@/features/http/components/NetworkConsole', () => ({ default: () => null }));

import { isElectron } from '@/lib/shared/platform';
import { shortcutCombo } from '@/lib/shared/shortcuts';
import { useConsoleStore } from '@/store/useConsoleStore';
import ConsoleDrawer from '../ConsoleDrawer';

beforeEach(() => {
  vi.mocked(isElectron).mockReturnValue(false);
  useConsoleStore.getState().setExpanded(false);
});

describe('console toggle shortcut (A13)', () => {
  it('uses a web combo that does not collide with browser DevTools (Ctrl/Cmd+Shift+C)', () => {
    expect(shortcutCombo('toggle-console', false)).toBe('alt+shift+keyc');
    expect(shortcutCombo('toggle-console', true)).toBe('mod+shift+c');
  });

  it('on web, Alt+Shift+C toggles the console and Ctrl+Shift+C is left to the browser', () => {
    render(<ConsoleDrawer />);
    const devtools = fireEvent.keyDown(window, {
      key: 'C',
      code: 'KeyC',
      ctrlKey: true,
      shiftKey: true,
    });
    expect(devtools).toBe(true); // not preventDefault-ed
    expect(useConsoleStore.getState().isExpanded).toBe(false);

    fireEvent.keyDown(window, { key: 'Ç', code: 'KeyC', altKey: true, shiftKey: true });
    expect(useConsoleStore.getState().isExpanded).toBe(true);
  });

  it('on desktop, Cmd/Ctrl+Shift+C toggles the console', () => {
    vi.mocked(isElectron).mockReturnValue(true);
    render(<ConsoleDrawer />);
    fireEvent.keyDown(window, {
      key: 'C',
      code: 'KeyC',
      ctrlKey: true,
      metaKey: true,
      shiftKey: true,
    });
    expect(useConsoleStore.getState().isExpanded).toBe(true);
  });
});
