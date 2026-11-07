import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/store/useSettingsStore';
import SettingsDrawer from '../SettingsDrawer';

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark', resolvedTheme: 'dark', setTheme: vi.fn() }),
}));

vi.mock('@/lib/shared/platform', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, isElectron: vi.fn(() => false), getElectronAPI: vi.fn(() => null) };
});

beforeEach(() => {
  useSettingsStore.getState().resetSettings();
});

describe('SettingsDrawer (A11)', () => {
  it('filters sections by name and keyword', async () => {
    const user = userEvent.setup();
    render(<SettingsDrawer open onOpenChange={vi.fn()} />);
    const nav = screen.getByRole('navigation', { name: /settings sections/i });

    await user.type(screen.getByRole('searchbox', { name: /filter settings/i }), 'proxy');
    expect(within(nav).getByRole('button', { name: /^Proxy$/ })).toBeInTheDocument();
    expect(within(nav).queryByRole('button', { name: /^About$/ })).toBeNull();

    await user.clear(screen.getByRole('searchbox', { name: /filter settings/i }));
    await user.type(screen.getByRole('searchbox', { name: /filter settings/i }), 'theme');
    // "theme" is a keyword of General/Appearance, not a section label.
    expect(within(nav).getByRole('button', { name: /^Appearance$/ })).toBeInTheDocument();
    expect(within(nav).queryByRole('button', { name: /^Proxy$/ })).toBeNull();

    await user.clear(screen.getByRole('searchbox', { name: /filter settings/i }));
    await user.type(screen.getByRole('searchbox', { name: /filter settings/i }), 'zzzz');
    expect(within(nav).getByText(/no matching settings/i)).toBeInTheDocument();
  });

  it('resets settings to defaults after confirmation', async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().updateSettings({ accent: '#22c55e', autoSaveHistory: false });
    render(<SettingsDrawer open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /reset to defaults/i }));
    expect(useSettingsStore.getState().settings.accent).toBe('#22c55e');
    await user.click(screen.getByRole('button', { name: /^reset$/i }));

    expect(useSettingsStore.getState().settings.accent).toBe('#2e91ff');
    expect(useSettingsStore.getState().settings.autoSaveHistory).not.toBe(false);
  });

  it('offers a compact section picker for narrow widths', async () => {
    const user = userEvent.setup();
    render(<SettingsDrawer open onOpenChange={vi.fn()} />);
    const picker = screen.getByRole('combobox', { name: /settings section/i });
    await user.selectOptions(picker, 'shortcuts');
    expect(screen.getAllByText('Shortcuts').length).toBeGreaterThan(1);
  });

  it('links to the desktop download from the web AI section', () => {
    render(<SettingsDrawer open onOpenChange={vi.fn()} initialSection="ai" />);
    expect(screen.getByRole('link', { name: /download the desktop app/i })).toHaveAttribute(
      'href',
      expect.stringContaining('releases')
    );
  });
});
