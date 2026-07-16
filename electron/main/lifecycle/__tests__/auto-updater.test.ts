import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyUpdaterConfig,
  getUpdaterStatus,
  registerAutoUpdaterIPC,
  setupAutoUpdater,
} from '../auto-updater';

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
    off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (listeners.get(event) === listener) listeners.delete(event);
      return autoUpdater;
    }),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  };

  return { autoUpdater, listeners };
});

const electronMock = vi.hoisted(() => {
  const nativeListeners = new Map<string, (...args: unknown[]) => void>();
  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const nativeAutoUpdater = {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      nativeListeners.set(event, listener);
      return nativeAutoUpdater;
    }),
    off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (nativeListeners.get(event) === listener) nativeListeners.delete(event);
      return nativeAutoUpdater;
    }),
  };
  return { ipcHandlers, nativeAutoUpdater, nativeListeners };
});

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.0.0') },
  autoUpdater: electronMock.nativeAutoUpdater,
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      electronMock.ipcHandlers.set(channel, handler);
    }),
  },
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
    electronMock.nativeListeners.clear();
    electronMock.ipcHandlers.clear();
    updaterMock.autoUpdater.quitAndInstall.mockReset();
    updaterMock.autoUpdater.autoDownload = true;
    updaterMock.autoUpdater.allowPrerelease = false;
    updaterMock.autoUpdater.allowDowngrade = true;
    updaterMock.autoUpdater.channel = 'beta';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it('waits for native macOS validation before announcing that an update is ready', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    setupAutoUpdater(() => null, false);

    updaterMock.listeners.get('update-downloaded')?.({ version: '1.1.0' });
    expect(getUpdaterStatus()).toEqual({ state: 'validating', version: '1.1.0' });

    electronMock.nativeListeners.get('update-downloaded')?.(undefined, undefined, '1.1.0');
    expect(getUpdaterStatus()).toEqual({ state: 'downloaded', version: '1.1.0' });
  });

  it('surfaces a safe validation error without leaking the native error', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    setupAutoUpdater(() => null, false);

    updaterMock.listeners.get('update-downloaded')?.({ version: '1.1.0' });
    updaterMock.listeners.get('error')?.(
      new Error('/Users/alice/private/Restura.zip failed signature validation')
    );

    expect(getUpdaterStatus()).toEqual({
      state: 'error',
      phase: 'validation',
      message: 'The update could not be verified. Try again or download it manually.',
    });
  });

  it('rejects restart before a macOS update is natively ready', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    setupAutoUpdater(() => null, false);
    registerAutoUpdaterIPC(false);

    updaterMock.listeners.get('update-downloaded')?.({ version: '1.1.0' });
    const restart = electronMock.ipcHandlers.get('updater:restart');

    await expect(restart?.()).rejects.toThrow('Update is not ready to install');
    expect(updaterMock.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('announces installation and restarts after native macOS readiness', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    setupAutoUpdater(() => null, false);
    registerAutoUpdaterIPC(false);

    updaterMock.listeners.get('update-downloaded')?.({ version: '1.1.0' });
    electronMock.nativeListeners.get('update-downloaded')?.(undefined, undefined, '1.1.0');
    const restart = electronMock.ipcHandlers.get('updater:restart');
    await restart?.();

    expect(getUpdaterStatus()).toEqual({ state: 'installing', version: '1.1.0' });
    expect(updaterMock.autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('consumes install readiness so rapid restart requests cannot install twice', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    setupAutoUpdater(() => null, false);
    registerAutoUpdaterIPC(false);

    updaterMock.listeners.get('update-downloaded')?.({ version: '1.1.0' });
    electronMock.nativeListeners.get('update-downloaded')?.();
    const restart = electronMock.ipcHandlers.get('updater:restart');

    await restart?.();
    await expect(restart?.()).rejects.toThrow('Update is not ready to install');
    expect(updaterMock.autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('uses electron-updater readiness directly on non-macOS platforms', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    setupAutoUpdater(() => null, false);

    updaterMock.listeners.get('update-downloaded')?.({ version: '1.1.0' });

    expect(getUpdaterStatus()).toEqual({ state: 'downloaded', version: '1.1.0' });
  });
});
