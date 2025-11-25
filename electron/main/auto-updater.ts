import { BrowserWindow, dialog, ipcMain } from 'electron';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import type { UpdateCheckResult } from 'electron-updater';

interface UpdateCheckResponse {
  updateAvailable: boolean;
  version?: string;
  message?: string;
  error?: string;
}

export function setupAutoUpdater(mainWindow: BrowserWindow | null, isDev: boolean): void {
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
    if (mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Available',
        message: `A new version (${info.version}) is available. It will be downloaded in the background.`,
        buttons: ['OK'],
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('No updates available');
  });

  autoUpdater.on('download-progress', (progress) => {
    console.log(`Download progress: ${progress.percent.toFixed(2)}%`);
    if (mainWindow) {
      mainWindow.setProgressBar(progress.percent / 100);
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info.version);
    if (mainWindow) {
      mainWindow.setProgressBar(-1);
      dialog
        .showMessageBox(mainWindow, {
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
    }
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
  ipcMain.handle('app:checkForUpdates', async (): Promise<UpdateCheckResponse> => {
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
  });
}
