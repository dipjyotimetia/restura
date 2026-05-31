import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import { IPC } from '../shared/channels';
import { createValidatedListener, NoInputSchema } from './ipc-validators';

export function registerWindowControlsIPC(getMainWindow: () => BrowserWindow | null): void {
  // createValidatedListener validates the sender frame before invoking the
  // handler, so a non-renderer frame can't drive the window chrome.
  ipcMain.on(
    IPC.window.minimize,
    createValidatedListener(IPC.window.minimize, NoInputSchema, () => {
      getMainWindow()?.minimize();
    })
  );

  ipcMain.on(
    IPC.window.maximize,
    createValidatedListener(IPC.window.maximize, NoInputSchema, () => {
      const mainWindow = getMainWindow();
      if (mainWindow?.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow?.maximize();
      }
    })
  );

  ipcMain.on(
    IPC.window.close,
    createValidatedListener(IPC.window.close, NoInputSchema, () => {
      getMainWindow()?.close();
    })
  );
}
