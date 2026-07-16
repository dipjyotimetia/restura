import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { UpdaterStatus } from '../../../../electron/types/electron-api';
import { UpdateNotification } from '../UpdateNotification';

// sonner — the App-level <Toaster> isn't mounted here; stub the toast surface
// the component uses (transient feedback for checks / download failures).
// vi.hoisted so the mock is initialized before the hoisted vi.mock factory runs.
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), promise: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

// Capture the status callback the component subscribes with so tests can drive
// each updater state through it.
let statusCb: ((s: UpdaterStatus) => void) | null = null;

const updater = {
  check: vi.fn(async () => ({ updateAvailable: false })),
  getStatus: vi.fn<() => Promise<UpdaterStatus>>(async () => ({ state: 'idle' })),
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
  shell: {
    openExternal: vi.fn(async () => undefined),
  },
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

  it('renders the last updater state when it subscribes after an update event', async () => {
    updater.getStatus.mockResolvedValueOnce({ state: 'downloaded', version: '2.1.0' });

    render(<UpdateNotification />);

    expect(await screen.findByText(/update v2\.1\.0 ready/i)).toBeInTheDocument();
    expect(updater.getStatus).toHaveBeenCalledOnce();
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

  it('opens the in-app release history from an available update', async () => {
    const onOpenReleaseNotes = vi.fn();
    window.addEventListener('restura:open-release-notes', onOpenReleaseNotes);
    render(<UpdateNotification />);
    emit({ state: 'available', version: '2.1.0' });

    await userEvent.click(screen.getByRole('button', { name: /what's new/i }));

    expect(onOpenReleaseNotes).toHaveBeenCalledOnce();
    window.removeEventListener('restura:open-release-notes', onOpenReleaseNotes);
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

  it('shows native validation and installation progress without offering restart', () => {
    render(<UpdateNotification />);

    emit({ state: 'validating', version: '2.1.0' });
    expect(screen.getByText(/verifying update/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /restart now/i })).toBeNull();

    emit({ state: 'installing', version: '2.1.0' });
    expect(screen.getByText(/restarting to install/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /restart now/i })).toBeNull();
  });

  it('Later dismisses the downloaded banner', async () => {
    render(<UpdateNotification />);
    emit({ state: 'downloaded', version: '2.1.0' });
    await userEvent.click(screen.getByRole('button', { name: /later/i }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stays silent (no banner, no toast) on an automatic background check failure', () => {
    render(<UpdateNotification />);
    emit({ state: 'error', phase: 'check', message: 'Unable to check for updates.' });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('keeps a download failure visible instead of relying only on a toast', () => {
    render(<UpdateNotification />);
    emit({
      state: 'error',
      phase: 'download',
      message: 'The update could not be downloaded. Try again or download it manually.',
    });
    expect(toastMock.error).toHaveBeenCalledWith(
      'Update download failed',
      expect.objectContaining({ description: expect.stringContaining('could not be downloaded') })
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/update download failed/i);
  });

  it('shows a validation failure with retry and manual download recovery', async () => {
    render(<UpdateNotification />);
    emit({
      state: 'error',
      phase: 'validation',
      message: 'The update could not be verified. Try again or download it manually.',
    });

    expect(screen.getByRole('alert')).toHaveTextContent(/update verification failed/i);
    expect(screen.queryByRole('button', { name: /restart now/i })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(updater.check).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole('button', { name: /manual download/i }));
    expect(api.shell.openExternal).toHaveBeenCalledWith(
      'https://github.com/dipjyotimetia/restura/releases/latest'
    );
  });

  it('gives the tray "Check for Updates" action transient toast feedback', () => {
    render(<UpdateNotification />);
    // The component registers a listener for the tray channel; invoke it.
    const call = api.on.mock.calls.find(([ch]) => ch === 'app:check-updates');
    expect(call).toBeDefined();
    act(() => {
      (call![1] as () => void)();
    });
    expect(updater.check).toHaveBeenCalledOnce();
    expect(toastMock.promise).toHaveBeenCalledOnce();
  });
});
