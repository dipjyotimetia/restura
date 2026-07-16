import type { BrowserWindow } from 'electron';
import {
  app,
  BrowserWindow as BrowserWindowCtor,
  ipcMain,
  autoUpdater as nativeAutoUpdater,
} from 'electron';
import electronLog from 'electron-log/main';
import type { UpdateCheckResult, UpdateInfo } from 'electron-updater';
import { autoUpdater, CancellationToken } from 'electron-updater';
import { createLogger } from '../../../src/lib/shared/logger';
import { EVENT, IPC } from '../../shared/channels';
import type { UpdaterErrorPhase, UpdaterStatus } from '../../types/electron-api';
import {
  createValidatedHandler,
  NoInputSchema,
  type UpdaterConfig,
  UpdaterConfigSchema,
} from '../ipc/ipc-validators';
import { showNativeNotification } from '../notifications';

const log = createLogger('updater');

interface UpdateCheckResponse {
  updateAvailable: boolean;
  version?: string;
  message?: string;
  error?: string;
}

// Module-level state shared between setupAutoUpdater (listeners + lifecycle)
// and registerAutoUpdaterIPC (renderer-driven actions), which are wired at
// different points in main.ts. A fresh CancellationToken backs each download so
// the renderer's Cancel button can abort it; lastUpdateInfo lets us re-broadcast
// the "available" state after a cancel without re-running the check.
let cancellationToken: CancellationToken | null = null;
let lastUpdateInfo: UpdateInfo | null = null;
let recheckInterval: ReturnType<typeof setInterval> | null = null;
let updaterStatus: UpdaterStatus = { state: 'idle' };
let updateReadyToInstall = false;
let updaterListenersCleanup: (() => void) | null = null;

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/** Updates are off in dev and when an operator opts out for air-gapped deploys. */
function updatesDisabled(isDev: boolean): boolean {
  return isDev || process.env.RESTURA_DISABLE_AUTO_UPDATE === 'true';
}

// Resolves the active BrowserWindow lazily on every event firing. The
// auto-updater outlives the initial window (window-all-closed on macOS,
// window:new IPC), so capturing a reference once would target a destroyed
// handle after a window close.
function withWindow(getWindow: () => BrowserWindow | null, fn: (w: BrowserWindow) => void): void {
  const w = getWindow();
  if (w && !w.isDestroyed()) fn(w);
}

/** Push a status update to every live renderer (multi-window safe). */
function broadcast(status: UpdaterStatus): void {
  updaterStatus = status;
  for (const w of BrowserWindowCtor.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(EVENT.updaterStatus, status);
  }
}

function errorPhaseFor(status: UpdaterStatus): UpdaterErrorPhase {
  switch (status.state) {
    case 'available':
    case 'downloading':
      return 'download';
    case 'validating':
      return 'validation';
    case 'downloaded':
    case 'installing':
      return 'install';
    default:
      return 'check';
  }
}

function safeErrorMessage(phase: UpdaterErrorPhase): string {
  switch (phase) {
    case 'download':
      return 'The update could not be downloaded. Try again or download it manually.';
    case 'validation':
      return 'The update could not be verified. Try again or download it manually.';
    case 'install':
      return 'The update could not be installed. Try again or download it manually.';
    default:
      return 'Unable to check for updates. Try again later.';
  }
}

function markUpdateReady(): void {
  updateReadyToInstall = true;
  broadcast({
    state: 'downloaded',
    version: lastUpdateInfo?.version,
  });
}

/** Returns the last known lifecycle state for renderers that subscribe late. */
export function getUpdaterStatus(): UpdaterStatus {
  return updaterStatus;
}

/**
 * Apply the user's update preferences to the live autoUpdater. `channel: beta`
 * maps to `allowPrerelease` (the GitHub-provider lever); `channel` is also set
 * for providers that key off the channel name. Persisted/synced from the
 * renderer via `updater:setConfig`.
 */
export function applyUpdaterConfig(config: UpdaterConfig): void {
  autoUpdater.autoDownload = config.autoDownload;
  autoUpdater.allowPrerelease = config.channel === 'beta';
  // Setting `channel` implicitly enables downgrades in electron-updater. A
  // stable-channel choice must return to the provider default (latest), and
  // neither setting should silently install an older signed build.
  autoUpdater.channel = config.channel === 'beta' ? 'beta' : null;
  autoUpdater.allowDowngrade = false;
}

export function setupAutoUpdater(getWindow: () => BrowserWindow | null, isDev: boolean): void {
  updaterListenersCleanup?.();
  updaterListenersCleanup = null;
  updateReadyToInstall = false;

  // Enterprise opt-out / dev: skip all update-check side effects. Distinct
  // from one another but both mean "never ping GitHub releases".
  if (updatesDisabled(isDev)) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  // Persist the full update lifecycle (check/available/progress/downloaded/
  // error) to the log file — the canonical electron-updater integration.
  autoUpdater.logger = electronLog;

  const onCheckingForUpdate = () => {
    broadcast({ state: 'checking' });
  };

  const onUpdateAvailable = (info: UpdateInfo) => {
    updateReadyToInstall = false;
    lastUpdateInfo = info;
    broadcast({
      state: 'available',
      version: info.version,
    });
    // If the window is backgrounded the user won't see the in-app banner, so
    // also fire a native OS notification (wires the previously-dead
    // notification:updateAvailable path).
    const focused = BrowserWindowCtor.getAllWindows().some(
      (w) => !w.isDestroyed() && w.isFocused()
    );
    if (!focused) {
      showNativeNotification(
        {
          title: '🚀 Update Available',
          body: `Version ${info.version} is available.`,
          urgency: 'normal',
        },
        getWindow(),
        isDev
      );
    }
  };

  const onUpdateNotAvailable = () => {
    updateReadyToInstall = false;
    lastUpdateInfo = null;
    broadcast({ state: 'not-available' });
  };

  const onDownloadProgress = (progress: { percent: number }) => {
    broadcast({ state: 'downloading', percent: progress.percent });
    withWindow(getWindow, (w) => w.setProgressBar(progress.percent / 100));
  };

  const onUpdateDownloaded = (info: UpdateInfo) => {
    lastUpdateInfo = info;
    withWindow(getWindow, (w) => w.setProgressBar(-1));
    if (process.platform === 'darwin') {
      broadcast({ state: 'validating', version: info.version });
    } else {
      markUpdateReady();
    }
  };

  const onError = (err: Error) => {
    withWindow(getWindow, (w) => w.setProgressBar(-1));
    const phase = errorPhaseFor(updaterStatus);
    log.error('auto-updater lifecycle failed', {
      phase,
      error: err instanceof Error ? err.message : String(err),
    });
    updateReadyToInstall = false;
    broadcast({ state: 'error', phase, message: safeErrorMessage(phase) });
  };

  const onNativeUpdateDownloaded = () => {
    markUpdateReady();
  };

  autoUpdater.on('checking-for-update', onCheckingForUpdate);
  autoUpdater.on('update-available', onUpdateAvailable);
  autoUpdater.on('update-not-available', onUpdateNotAvailable);
  autoUpdater.on('download-progress', onDownloadProgress);
  autoUpdater.on('update-downloaded', onUpdateDownloaded);
  autoUpdater.on('error', onError);
  if (process.platform === 'darwin') {
    nativeAutoUpdater.on('update-downloaded', onNativeUpdateDownloaded);
  }

  updaterListenersCleanup = () => {
    autoUpdater.off('checking-for-update', onCheckingForUpdate);
    autoUpdater.off('update-available', onUpdateAvailable);
    autoUpdater.off('update-not-available', onUpdateNotAvailable);
    autoUpdater.off('download-progress', onDownloadProgress);
    autoUpdater.off('update-downloaded', onUpdateDownloaded);
    autoUpdater.off('error', onError);
    if (process.platform === 'darwin') {
      nativeAutoUpdater.off('update-downloaded', onNativeUpdateDownloaded);
    }
  };

  // First check shortly after launch, then poll every 6h so a long-running
  // desktop session still discovers releases without a restart.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log.error('update check failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }, 3000);

  if (!recheckInterval) {
    recheckInterval = setInterval(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        log.error('periodic update check failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, SIX_HOURS_MS);
  }
}

export function registerAutoUpdaterIPC(isDev: boolean): void {
  // Legacy single-shot check (kept for backwards compatibility; superseded by
  // IPC.updater.check which shares the same response shape).
  const handleCheck = async (): Promise<UpdateCheckResponse> => {
    if (process.env.RESTURA_DISABLE_AUTO_UPDATE === 'true') {
      return { updateAvailable: false, message: 'Updates disabled by RESTURA_DISABLE_AUTO_UPDATE' };
    }
    if (isDev) {
      return { updateAvailable: false, message: 'Updates disabled in development' };
    }
    try {
      const result: UpdateCheckResult | null = await autoUpdater.checkForUpdates();
      const latestVersion = result?.updateInfo?.version;
      const updateAvailable = latestVersion != null && latestVersion !== app.getVersion();
      return {
        updateAvailable,
        version: latestVersion,
      };
    } catch (error) {
      log.error('renderer update check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { updateAvailable: false, error: safeErrorMessage('check') };
    }
  };

  // Wrapped in createValidatedHandler — input is empty but the wrapper still
  // enforces assertTrustedSender, keeping the "every channel routes through
  // one validator" invariant grep-auditable.
  ipcMain.handle(
    IPC.app.checkForUpdates,
    createValidatedHandler(IPC.app.checkForUpdates, NoInputSchema, handleCheck)
  );

  ipcMain.handle(
    IPC.updater.check,
    createValidatedHandler(IPC.updater.check, NoInputSchema, handleCheck)
  );

  ipcMain.handle(
    IPC.updater.status,
    createValidatedHandler(
      IPC.updater.status,
      NoInputSchema,
      async (): Promise<UpdaterStatus> => getUpdaterStatus()
    )
  );

  ipcMain.handle(
    IPC.updater.download,
    createValidatedHandler(
      IPC.updater.download,
      NoInputSchema,
      async (): Promise<{ ok: boolean; error?: string }> => {
        if (updatesDisabled(isDev)) return { ok: false, error: 'Updates disabled' };
        cancellationToken = new CancellationToken();
        try {
          await autoUpdater.downloadUpdate(cancellationToken);
          return { ok: true };
        } catch (error) {
          // A user-initiated cancel rejects this promise — surface the
          // "available" state again rather than an error. Anything else is a
          // genuine failure.
          if (cancellationToken?.cancelled) {
            if (lastUpdateInfo) {
              broadcast({
                state: 'available',
                version: lastUpdateInfo.version,
              });
            }
            return { ok: false, error: 'cancelled' };
          }
          log.error('renderer update download failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          return { ok: false, error: safeErrorMessage('download') };
        }
      }
    )
  );

  ipcMain.handle(
    IPC.updater.cancel,
    createValidatedHandler(
      IPC.updater.cancel,
      NoInputSchema,
      async (): Promise<{ ok: boolean }> => {
        cancellationToken?.cancel();
        return { ok: true };
      }
    )
  );

  ipcMain.handle(
    IPC.updater.restart,
    createValidatedHandler(IPC.updater.restart, NoInputSchema, async (): Promise<void> => {
      if (updatesDisabled(isDev)) return;
      if (!updateReadyToInstall) {
        throw new Error('Update is not ready to install');
      }
      broadcast({ state: 'installing', version: lastUpdateInfo?.version });
      autoUpdater.quitAndInstall(false, true);
    })
  );

  ipcMain.handle(
    IPC.updater.setConfig,
    createValidatedHandler(
      IPC.updater.setConfig,
      UpdaterConfigSchema,
      async (config: UpdaterConfig): Promise<void> => {
        if (updatesDisabled(isDev)) return;
        applyUpdaterConfig(config);
      }
    )
  );
}
