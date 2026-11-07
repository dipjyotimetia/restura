import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/shared/platform', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  isElectron: vi.fn(() => false),
  isMac: vi.fn(() => false),
}));

import { isElectron } from '@/lib/shared/platform';
import { shortcutHint } from '@/lib/shared/shortcuts';

describe('shortcutHint', () => {
  it('shows the web console combo (not the DevTools one) on web', () => {
    vi.mocked(isElectron).mockReturnValue(false);
    expect(shortcutHint('toggle-console')).toMatch(/Alt\+Shift\+C/i);
  });

  it('shows the desktop combo on Electron', () => {
    vi.mocked(isElectron).mockReturnValue(true);
    expect(shortcutHint('toggle-console')).toMatch(/Ctrl\+Shift\+C/i);
  });
});
