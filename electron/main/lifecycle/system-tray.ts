import * as fs from 'fs';
import type { BrowserWindow } from 'electron';
import { Tray, Menu, nativeImage } from 'electron';
import { createLogger } from '../../../src/lib/shared/logger';
import { getResourcePath } from '../window-manager';

const log = createLogger('tray');

let tray: Tray | null = null;

/**
 * Resolve the tray icon. On macOS we prefer the monochrome
 * `trayIconTemplate.png` (black + alpha) which the OS recolours for light/dark
 * menu bars — but ONLY when it actually exists. `isTemplate` gates
 * `setTemplateImage`: applying it to the full-colour `icon.png` fallback would
 * paint the menu bar as a featureless solid blob (template mode uses alpha
 * only), so the flag must follow which file we actually loaded.
 */
function getTrayIconPath(isDev: boolean): { path: string; isTemplate: boolean } {
  if (process.platform === 'darwin') {
    const templatePath = getResourcePath('trayIconTemplate.png', isDev);
    if (fs.existsSync(templatePath)) return { path: templatePath, isTemplate: true };
  }
  const iconPath = getResourcePath('icon.png', isDev);
  if (fs.existsSync(iconPath)) return { path: iconPath, isTemplate: false };
  return { path: '', isTemplate: false };
}

export function createSystemTray(
  getMainWindow: () => BrowserWindow | null,
  isDev: boolean
): Tray | null {
  const { path: iconPath, isTemplate } = getTrayIconPath(isDev);

  if (!iconPath) {
    log.warn('tray icon not found, skipping system tray creation');
    return null;
  }

  const icon = nativeImage.createFromPath(iconPath);
  // The monochrome template is generated at the exact menu-bar size (16px + a
  // 32px @2x rep that createFromPath auto-loads), so resizing it would discard
  // the retina representation and blur on HiDPI bars. The full-colour fallback
  // (the 512px app icon) must be scaled down. Either way, apply the template
  // flag to the image we actually hand to Tray: resize() returns a NEW
  // NativeImage that does NOT carry isTemplateImage across.
  const trayIcon = isTemplate ? icon : icon.resize({ width: 16, height: 16 });
  if (isTemplate) trayIcon.setTemplateImage(true);

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
      label: 'New Request',
      accelerator: 'CmdOrCtrl+N',
      click: () =>
        withWindow((w) => {
          w.show();
          w.webContents.send('menu:new-request');
        }),
    },
    {
      label: 'Import Collection',
      click: () =>
        withWindow((w) => {
          w.show();
          w.webContents.send('menu:import');
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
