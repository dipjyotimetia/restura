// @vitest-environment node
//
// auto-updater config application, dev/opt-out gating, and IPC registration.
// electron-updater is mocked (ESM import, so vi.mock intercepts it); the real
// network/update lifecycle is out of scope for unit tests.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { autoUpdater } = vi.hoisted(() => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    channel: 'latest' as string,
    logger: null as unknown,
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}));

import { createElectronMock, silenceLogger } from './helpers/electron-mock';

vi.mock('electron', () => createElectronMock());
vi.mock('electron-updater', () => ({
  autoUpdater,
  CancellationToken: class {},
}));
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../notifications', () => ({ showNativeNotification: vi.fn() }));
vi.mock('../../../src/lib/shared/logger', (orig) => silenceLogger(orig));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/channels';
import { applyUpdaterConfig, setupAutoUpdater, registerAutoUpdaterIPC } from '../auto-updater';

describe('applyUpdaterConfig', () => {
  it('maps the stable channel to latest with prerelease off', () => {
    applyUpdaterConfig({ autoDownload: true, channel: 'stable' } as never);
    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.allowPrerelease).toBe(false);
    expect(autoUpdater.channel).toBe('latest');
  });

  it('maps the beta channel to prerelease', () => {
    applyUpdaterConfig({ autoDownload: false, channel: 'beta' } as never);
    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.allowPrerelease).toBe(true);
    expect(autoUpdater.channel).toBe('beta');
  });
});

describe('setupAutoUpdater', () => {
  beforeEach(() => {
    autoUpdater.on.mockClear();
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    delete process.env.RESTURA_DISABLE_AUTO_UPDATE;
  });

  it('disables updates and registers no listeners in dev', () => {
    setupAutoUpdater(() => null, true);
    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
    expect(autoUpdater.on).not.toHaveBeenCalled();
  });

  it('honours the air-gapped opt-out env var', () => {
    process.env.RESTURA_DISABLE_AUTO_UPDATE = 'true';
    setupAutoUpdater(() => null, false);
    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.on).not.toHaveBeenCalled();
  });

  it('enables updates and wires lifecycle listeners in production', () => {
    setupAutoUpdater(() => null, false);
    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(autoUpdater.on).toHaveBeenCalled();
  });

  afterEach(() => {
    delete process.env.RESTURA_DISABLE_AUTO_UPDATE;
  });
});

describe('registerAutoUpdaterIPC', () => {
  beforeEach(() => vi.mocked(ipcMain.handle).mockClear());

  it('registers the updater channels', () => {
    registerAutoUpdaterIPC(false);
    const channels = vi.mocked(ipcMain.handle).mock.calls.map((c) => c[0]);
    expect(channels).toEqual(
      expect.arrayContaining([
        IPC.updater.check,
        IPC.updater.download,
        IPC.updater.cancel,
        IPC.updater.restart,
        IPC.updater.setConfig,
      ])
    );
  });
});
