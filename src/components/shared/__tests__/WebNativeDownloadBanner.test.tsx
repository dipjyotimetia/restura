import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebNativeDownloadBanner } from '../WebNativeDownloadBanner';

vi.mock('@/lib/shared/platform', () => ({
  isElectron: vi.fn(() => false),
}));

import { isElectron } from '@/lib/shared/platform';

const releaseUrl = 'https://github.com/dipjyotimetia/restura/releases/latest';

beforeEach(() => {
  vi.mocked(isElectron).mockReturnValue(false);
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
});
