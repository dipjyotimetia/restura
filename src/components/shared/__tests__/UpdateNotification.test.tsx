import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdateNotification } from '../UpdateNotification';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { UpdaterStatus } from '../../../../electron/types/electron-api';

// sonner — the App-level <Toaster> isn't mounted here; stub toast so error-state
// renders don't depend on it.
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

// Capture the status callback the component subscribes with so tests can drive
// each updater state through it.
let statusCb: ((s: UpdaterStatus) => void) | null = null;

const updater = {
  check: vi.fn(async () => ({ updateAvailable: false })),
  download: vi.fn(async () => ({ ok: true })),
  cancel: vi.fn(async () => ({ ok: true })),
  restart: vi.fn(async () => undefined),
  setConfig: vi.fn(async () => undefined),
  onStatus: vi.fn((cb: (s: UpdaterStatus) => void) => {
    statusCb = cb;
    return () => {
      statusCb = null;
    };
  }),
};

const api = {
  updater,
  on: vi.fn(),
  removeListener: vi.fn(),
};

vi.mock('@/lib/shared/platform', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    isElectron: vi.fn(() => true),
    getElectronAPI: vi.fn(() => api),
  };
});

function emit(status: UpdaterStatus) {
  act(() => {
    statusCb?.(status);
  });
}

describe('UpdateNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statusCb = null;
    useSettingsStore
      .getState()
      .updateSettings({ autoUpdate: { autoDownload: true, channel: 'stable' } });
  });

  it('renders nothing for idle/checking/not-available states', () => {
    render(<UpdateNotification />);
    expect(screen.queryByRole('status')).toBeNull();
    emit({ state: 'checking' });
    expect(screen.queryByRole('status')).toBeNull();
    emit({ state: 'not-available' });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('syncs config to the main process on mount', () => {
    render(<UpdateNotification />);
    expect(updater.setConfig).toHaveBeenCalledWith({ autoDownload: true, channel: 'stable' });
  });

  it('shows a Download button when auto-download is off', async () => {
    useSettingsStore
      .getState()
      .updateSettings({ autoUpdate: { autoDownload: false, channel: 'stable' } });
    render(<UpdateNotification />);
    emit({ state: 'available', version: '2.1.0' });

    expect(screen.getByText('v2.1.0')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /download/i });
    await userEvent.click(btn);
    expect(updater.download).toHaveBeenCalledOnce();
  });

  it('renders a progress bar and Cancel while downloading', async () => {
    render(<UpdateNotification />);
    emit({ state: 'downloading', version: '2.1.0', percent: 45 });

    expect(screen.getByText('45%')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(updater.cancel).toHaveBeenCalledOnce();
  });

  it('offers Restart now when the update is downloaded', async () => {
    render(<UpdateNotification />);
    emit({ state: 'downloaded', version: '2.1.0' });

    expect(screen.getByText(/ready/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /restart now/i }));
    expect(updater.restart).toHaveBeenCalledOnce();
  });

  it('Later dismisses the downloaded banner', async () => {
    render(<UpdateNotification />);
    emit({ state: 'downloaded', version: '2.1.0' });
    await userEvent.click(screen.getByRole('button', { name: /later/i }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('surfaces an error state', () => {
    render(<UpdateNotification />);
    emit({ state: 'error', message: 'network down' });
    expect(screen.getByText(/update failed/i)).toBeInTheDocument();
  });
});
