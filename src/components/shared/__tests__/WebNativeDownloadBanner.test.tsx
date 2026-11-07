import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/store/useSettingsStore';
import { WebNativeDownloadBanner } from '../WebNativeDownloadBanner';

vi.mock('@/lib/shared/platform', () => ({
  isElectron: vi.fn(() => false),
}));

import { isElectron } from '@/lib/shared/platform';

const releaseUrl = 'https://github.com/dipjyotimetia/restura/releases/latest';

beforeEach(() => {
  vi.mocked(isElectron).mockReturnValue(false);
  useSettingsStore.setState((state) => ({
    settings: { ...state.settings, nativeAppDownloadBannerDismissedUntil: undefined },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WebNativeDownloadBanner', () => {
  it('shows native app download links on the web', () => {
    render(<WebNativeDownloadBanner />);

    expect(screen.getByRole('complementary', { name: /native app download/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /download for macos/i })).toHaveAttribute(
      'href',
      releaseUrl
    );
    expect(screen.getByRole('link', { name: /download for windows/i })).toHaveAttribute(
      'href',
      releaseUrl
    );
    expect(screen.getByRole('link', { name: /download for linux/i })).toHaveAttribute(
      'href',
      releaseUrl
    );
  });

  it('is not rendered inside the native app', () => {
    vi.mocked(isElectron).mockReturnValue(true);
    render(<WebNativeDownloadBanner />);

    expect(
      screen.queryByRole('complementary', { name: /native app download/i })
    ).not.toBeInTheDocument();
  });

  it('opens the operating system chooser from the download control', async () => {
    const user = userEvent.setup();
    render(<WebNativeDownloadBanner />);

    const chooser = screen.getByRole('group');
    expect(chooser).not.toHaveAttribute('open');

    await user.click(screen.getByText('Download native app', { exact: true }));

    expect(chooser).toHaveAttribute('open');
  });

  it('hides the banner for 30 days when dismissed', async () => {
    const now = 1_720_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const user = userEvent.setup();
    render(<WebNativeDownloadBanner />);

    await user.click(screen.getByRole('button', { name: /dismiss native app download/i }));

    expect(
      screen.queryByRole('complementary', { name: /native app download/i })
    ).not.toBeInTheDocument();
    expect(useSettingsStore.getState().settings.nativeAppDownloadBannerDismissedUntil).toBe(
      now + 30 * 24 * 60 * 60 * 1000
    );
  });

  it('shows the banner after a previous dismissal has expired', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_720_000_000_000);
    act(() => {
      useSettingsStore.getState().updateSettings({
        nativeAppDownloadBannerDismissedUntil: 1_719_999_999_999,
      });
    });

    render(<WebNativeDownloadBanner />);

    expect(screen.getByRole('complementary', { name: /native app download/i })).toBeInTheDocument();
  });

  it('never schedules a re-check longer than setTimeout can hold (no 1ms loop for a 30-day dismissal)', () => {
    const now = 1_720_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    act(() => {
      useSettingsStore.getState().updateSettings({
        nativeAppDownloadBannerDismissedUntil: now + 30 * 24 * 60 * 60 * 1000,
      });
    });

    render(<WebNativeDownloadBanner />);

    const delays = setTimeoutSpy.mock.calls.map(([, delay]) => Number(delay ?? 0));
    expect(delays.length).toBeGreaterThan(0);
    for (const delay of delays) expect(delay).toBeLessThanOrEqual(2_147_483_647);
  });
});
