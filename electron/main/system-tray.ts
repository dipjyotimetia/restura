import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

let tray: Tray | null = null;

function getResourcePath(resource: string, isDev: boolean): string {
  if (isDev) {
    return path.join(__dirname, '../../../electron/resources', resource);
  } else {
    return path.join(app.getAppPath(), 'electron/resources', resource);
  }
}

function getTrayIconPath(isDev: boolean): string {
  // Try to get a template icon for macOS (for proper dark mode support)
  if (process.platform === 'darwin') {
    const templatePath = getResourcePath('trayIconTemplate.png', isDev);
    if (fs.existsSync(templatePath)) {
      return templatePath;
    }
  }

  // Fallback to regular icon
  const iconPath = getResourcePath('icon.png', isDev);
  if (fs.existsSync(iconPath)) {
    return iconPath;
  }

  // Return empty string to use default
  return '';
}

export function createSystemTray(mainWindow: BrowserWindow | null, isDev: boolean): Tray | null {
  const iconPath = getTrayIconPath(isDev);

  if (!iconPath) {
    console.warn('Tray icon not found, skipping system tray creation');
    return null;
  }

  const icon = nativeImage.createFromPath(iconPath);

  // For macOS, make it a template image
  if (process.platform === 'darwin') {
    icon.setTemplateImage(true);
  }

  // Resize for tray (16x16 is standard)
  const trayIcon = icon.resize({ width: 16, height: 16 });

  tray = new Tray(trayIcon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Restura',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      type: 'separator',
    },
    {
      label: 'New Request',
      accelerator: 'CmdOrCtrl+N',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.webContents.send('menu:new-request');
        }
      },
    },
    {
      label: 'Import Collection',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.webContents.send('menu:import');
        }
      },
    },
    {
      type: 'separator',
    },
    {
      label: 'Check for Updates',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.webContents.send('app:check-updates');
        }
      },
    },
    {
      type: 'separator',
    },
    {
      label: 'Quit Restura',
      role: 'quit',
    },
  ]);

  tray.setToolTip('Restura - API Testing Tool');
  tray.setContextMenu(contextMenu);

  // On click, show the window (primarily for Windows/Linux)
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    }
  });

  // Double-click to show window (Windows)
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  return tray;
}

export function updateTrayTooltip(status: string): void {
  if (tray) {
    tray.setToolTip(`Restura - ${status}`);
  }
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
