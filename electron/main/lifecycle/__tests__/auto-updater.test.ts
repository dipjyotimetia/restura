import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyUpdaterConfig, getUpdaterStatus, setupAutoUpdater } from '../auto-updater';

const updaterMock = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    allowDowngrade: false,
    channel: null as string | null,
    logger: undefined as unknown,
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
      return autoUpdater;
    }),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  };

  return { autoUpdater, listeners };
});

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.0.0') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
}));

vi.mock('electron-log/main', () => ({ default: {} }));

vi.mock('electron-updater', () => ({
  autoUpdater: updaterMock.autoUpdater,
  CancellationToken: class {
    cancelled = false;
    cancel() {
      this.cancelled = true;
    }
  },
}));

vi.mock('../../ipc/ipc-validators', () => ({
  NoInputSchema: {},
  UpdaterConfigSchema: {},
  createValidatedHandler: (_channel: string, _schema: unknown, handler: unknown) => handler,
}));

vi.mock('../../notifications', () => ({ showNativeNotification: vi.fn() }));

describe('auto-updater configuration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    updaterMock.listeners.clear();
    updaterMock.autoUpdater.autoDownload = true;
    updaterMock.autoUpdater.allowPrerelease = false;
    updaterMock.autoUpdater.allowDowngrade = true;
    updaterMock.autoUpdater.channel = 'beta';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps stable updates on the default channel without allowing a downgrade', () => {
    applyUpdaterConfig({ autoDownload: false, channel: 'stable' });

    expect(updaterMock.autoUpdater.autoDownload).toBe(false);
    expect(updaterMock.autoUpdater.allowPrerelease).toBe(false);
    expect(updaterMock.autoUpdater.channel).toBeNull();
    expect(updaterMock.autoUpdater.allowDowngrade).toBe(false);
  });

  it('replays an available update through the current updater status', () => {
    setupAutoUpdater(() => null, false);

    updaterMock.listeners.get('update-available')?.({ version: '1.1.0' });

    expect(getUpdaterStatus()).toEqual({ state: 'available', version: '1.1.0' });
  });
});
