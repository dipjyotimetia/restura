import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/shared/platform', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, isElectron: vi.fn(() => false) };
});

import { isElectron } from '@/lib/shared/platform';
import { useSettingsStore } from '@/store/useSettingsStore';
import CommandPalette from '../CommandPalette';

function setNarrow(narrow: boolean) {
  vi.mocked(window.matchMedia).mockImplementation(
    (query: string) =>
      ({
        matches: narrow && query.includes('max-width: 1279px'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList
  );
}

function renderPalette(onChangeMode = vi.fn()) {
  render(<CommandPalette open onOpenChange={() => {}} onChangeMode={onChangeMode} />);
  return onChangeMode;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(isElectron).mockReturnValue(false);
  setNarrow(false);
  useSettingsStore.getState().updateSettings({ layoutOrientation: 'horizontal' });
});

describe('CommandPalette platform gating (A12)', () => {
  it('lists desktop-only protocols on web as disabled with a "Desktop only" reason', async () => {
    const user = userEvent.setup();
    const onChangeMode = renderPalette();
    const kafka = screen.getByRole('option', { name: /kafka/i });
    expect(kafka).toHaveAttribute('aria-disabled', 'true');
    expect(kafka).toHaveTextContent(/desktop only/i);
    await user.click(kafka);
    expect(onChangeMode).not.toHaveBeenCalled();
    expect(screen.getByRole('option', { name: /mqtt/i })).toHaveAttribute('aria-disabled', 'true');
  });

  it('enables desktop-only protocols on desktop', () => {
    vi.mocked(isElectron).mockReturnValue(true);
    renderPalette();
    expect(screen.getByRole('option', { name: /kafka/i })).not.toHaveAttribute('aria-disabled');
  });
});

describe('CommandPalette layout toggle on narrow windows (A6)', () => {
  it('disables the layout toggle with a reason when the window forces stacked layout', async () => {
    const user = userEvent.setup();
    setNarrow(true);
    renderPalette();
    const toggle = screen.getByRole('option', { name: /side-by-side/i });
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    expect(toggle).toHaveTextContent(/window too narrow for side-by-side/i);
    await user.click(toggle);
    expect(useSettingsStore.getState().settings.layoutOrientation).toBe('horizontal');
  });

  it('toggles the layout on wide windows', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(screen.getByRole('option', { name: /side-by-side/i }));
    expect(useSettingsStore.getState().settings.layoutOrientation).toBe('vertical');
  });
});
