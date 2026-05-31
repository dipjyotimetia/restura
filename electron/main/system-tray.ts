import type { BrowserWindow } from 'electron';
import { Tray, Menu, nativeImage } from 'electron';
import * as fs from 'fs';
import { getResourcePath } from './window-manager';
import { createLogger } from '../../src/lib/shared/logger';

const log = createLogger('tray');

let tray: Tray | null = null;

function getTrayIconPath(isDev: boolean): string {
  if (process.platform === 'darwin') {
    const templatePath = getResourcePath('trayIconTemplate.png', isDev);
    if (fs.existsSync(templatePath)) return templatePath;
  }
  const iconPath = getResourcePath('icon.png', isDev);
  if (fs.existsSync(iconPath)) return iconPath;
  return '';
}

export function createSystemTray(
  getMainWindow: () => BrowserWindow | null,
  isDev: boolean
): Tray | null {
  const iconPath = getTrayIconPath(isDev);

  if (!iconPath) {
    log.warn('tray icon not found, skipping system tray creation');
    return null;
  }

  const icon = nativeImage.createFromPath(iconPath);
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  const trayIcon = icon.resize({ width: 16, height: 16 });

  tray = new Tray(trayIcon);

  const withWindow = (fn: (w: BrowserWindow) => void): void => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) fn(w);
  };

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Restura',
      click: () =>
        withWindow((w) => {
          w.show();
          w.focus();
        }),
    },
    { type: 'separator' },
    {
      label: 'Check for Updates',
      click: () =>
        withWindow((w) => {
          w.show();
          w.webContents.send('app:check-updates');
        }),
    },
    { type: 'separator' },
    { label: 'Quit Restura', role: 'quit' },
  ]);

  tray.setToolTip('Restura - API Testing Tool');
  tray.setContextMenu(contextMenu);

  tray.on('click', () =>
    withWindow((w) => {
      if (w.isVisible()) {
        w.focus();
      } else {
        w.show();
      }
    })
  );

  tray.on('double-click', () =>
    withWindow((w) => {
      w.show();
      w.focus();
    })
  );

  return tray;
}

export function updateTrayTooltip(status: string): void {
  if (tray) tray.setToolTip(`Restura - ${status}`);
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

export function getTray(): Tray | null {
  return tray;
}
