import type { BrowserWindow} from 'electron';
import { dialog, ipcMain } from 'electron';
import type { UpdateCheckResult } from 'electron-updater';
import { autoUpdater } from 'electron-updater';
import { createValidatedHandler, NoInputSchema } from './ipc-validators';

interface UpdateCheckResponse {
  updateAvailable: boolean;
  version?: string;
  message?: string;
  error?: string;
}

// Resolves the active BrowserWindow lazily on every event firing. The
// auto-updater outlives the initial window (window-all-closed on macOS,
// window:new IPC), so capturing a reference once would target a destroyed
// handle after a window close.
function withWindow(getWindow: () => BrowserWindow | null, fn: (w: BrowserWindow) => void): void {
  const w = getWindow();
  if (w && !w.isDestroyed()) fn(w);
}

export function setupAutoUpdater(getWindow: () => BrowserWindow | null, isDev: boolean): void {
  // Enterprise opt-out: skip all update-check side effects when the
  // operator sets RESTURA_DISABLE_AUTO_UPDATE=true. Distinct from `isDev`
  // because enterprise production deploys still set NODE_ENV=production
  // but want air-gapped behaviour (no GitHub release pings).
  if (process.env.RESTURA_DISABLE_AUTO_UPDATE === 'true') {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    return;
  }

  if (isDev) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => {
    console.log('Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info.version);
    withWindow(getWindow, (w) => {
      dialog.showMessageBox(w, {
        type: 'info',
        title: 'Update Available',
        message: `A new version (${info.version}) is available. It will be downloaded in the background.`,
        buttons: ['OK'],
      });
    });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('No updates available');
  });

  autoUpdater.on('download-progress', (progress) => {
    console.log(`Download progress: ${progress.percent.toFixed(2)}%`);
    withWindow(getWindow, (w) => w.setProgressBar(progress.percent / 100));
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info.version);
    withWindow(getWindow, (w) => {
      w.setProgressBar(-1);
      dialog
        .showMessageBox(w, {
          type: 'info',
          title: 'Update Ready',
          message: `Version ${info.version} has been downloaded. Restart the app to apply the update.`,
          buttons: ['Restart Now', 'Later'],
          defaultId: 0,
        })
        .then((result) => {
          if (result.response === 0) {
            autoUpdater.quitAndInstall(false, true);
          }
        });
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-updater error:', err);
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('Failed to check for updates:', err);
    });
  }, 3000);
}

export function registerAutoUpdaterIPC(isDev: boolean): void {
  // Wrapped in createValidatedHandler — input is empty but the wrapper still
  // enforces assertTrustedSender, keeping the "every channel routes through
  // one validator" invariant grep-auditable.
  ipcMain.handle(
    'app:checkForUpdates',
    createValidatedHandler(
      'app:checkForUpdates',
      NoInputSchema,
      async (): Promise<UpdateCheckResponse> => {
        if (process.env.RESTURA_DISABLE_AUTO_UPDATE === 'true') {
          return { updateAvailable: false, message: 'Updates disabled by RESTURA_DISABLE_AUTO_UPDATE' };
        }
        if (isDev) {
          return { updateAvailable: false, message: 'Updates disabled in development' };
        }
        try {
          const result: UpdateCheckResult | null = await autoUpdater.checkForUpdates();
          return {
            updateAvailable: result?.updateInfo != null,
            version: result?.updateInfo?.version,
          };
        } catch (error) {
          return { updateAvailable: false, error: String(error) };
        }
      }
    )
  );
}
