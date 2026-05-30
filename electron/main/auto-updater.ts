import type { BrowserWindow } from 'electron';
import { app, BrowserWindow as BrowserWindowCtor, ipcMain } from 'electron';
import type { UpdateCheckResult, UpdateInfo } from 'electron-updater';
import { autoUpdater, CancellationToken } from 'electron-updater';
import {
  createValidatedHandler,
  NoInputSchema,
  UpdaterConfigSchema,
  type UpdaterConfig,
} from './ipc-validators';
import { showNativeNotification } from './notifications';
import { EVENT, IPC } from '../shared/channels';
import type { UpdaterStatus } from '../types/electron-api';
import electronLog from 'electron-log/main';
import { createLogger } from '../../src/lib/shared/logger';

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
  for (const w of BrowserWindowCtor.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(EVENT.updaterStatus, status);
  }
}

/**
 * electron-updater's `releaseNotes` is `string | Array<{version, note}>` (the
 * array form when `fullChangelog` is on). Collapse both to a single string the
 * renderer can render verbatim.
 */
function normalizeReleaseNotes(info: UpdateInfo): string | undefined {
  const notes = info.releaseNotes;
  if (!notes) return undefined;
  if (typeof notes === 'string') return notes;
  return notes
    .map((n) => (n.version ? `## ${n.version}\n${n.note ?? ''}` : (n.note ?? '')))
    .join('\n\n')
    .trim();
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
  autoUpdater.channel = config.channel === 'beta' ? 'beta' : 'latest';
}

export function setupAutoUpdater(getWindow: () => BrowserWindow | null, isDev: boolean): void {
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

  autoUpdater.on('checking-for-update', () => {
    broadcast({ state: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    lastUpdateInfo = info;
    broadcast({
      state: 'available',
      version: info.version,
      releaseNotes: normalizeReleaseNotes(info),
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
  });

  autoUpdater.on('update-not-available', () => {
    broadcast({ state: 'not-available' });
  });

  autoUpdater.on('download-progress', (progress) => {
    broadcast({ state: 'downloading', percent: progress.percent });
    withWindow(getWindow, (w) => w.setProgressBar(progress.percent / 100));
  });

  autoUpdater.on('update-downloaded', (info) => {
    lastUpdateInfo = info;
    withWindow(getWindow, (w) => w.setProgressBar(-1));
    broadcast({
      state: 'downloaded',
      version: info.version,
      releaseNotes: normalizeReleaseNotes(info),
    });
  });

  autoUpdater.on('error', (err) => {
    withWindow(getWindow, (w) => w.setProgressBar(-1));
    broadcast({ state: 'error', message: String(err) });
  });

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
      return { updateAvailable: false, error: String(error) };
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
                releaseNotes: normalizeReleaseNotes(lastUpdateInfo),
              });
            }
            return { ok: false, error: 'cancelled' };
          }
          return { ok: false, error: String(error) };
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
