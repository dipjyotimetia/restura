import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import { IPC } from '../shared/channels';

export function registerWindowControlsIPC(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.on(IPC.window.minimize, () => {
    getMainWindow()?.minimize();
  });

  ipcMain.on(IPC.window.maximize, () => {
    const mainWindow = getMainWindow();
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.on(IPC.window.close, () => {
    getMainWindow()?.close();
  });
}
