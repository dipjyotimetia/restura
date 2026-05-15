import { app, BrowserWindow, shell, Menu, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { z } from 'zod';
import { createApplicationMenu } from './menu';
import { SAFE_OPEN_PROTOCOLS } from './ipc-validators';
import { bindLimiterToWebContents } from './rate-limiter-cleanup';
import { httpRateLimiter } from './http-handler';
import { grpcRateLimiter } from './grpc-handler';
import { wsRateLimiter } from './websocket-handler';
import { sseRateLimiter } from './sse-handler';
import { mcpRateLimiter } from './mcp-handler';
import { notificationRateLimiter } from './notifications';

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized: boolean;
}

/**
 * Zod schema mirroring WindowState. Validated on load so that a corrupted
 * window-state.json (partial flush after crash, hand-edit, version skew)
 * cannot poison BrowserWindow construction with the wrong types — we just
 * fall back to defaults.
 */
const WindowStateSchema = z.object({
  width: z.number(),
  height: z.number(),
  x: z.number().optional(),
  y: z.number().optional(),
  isMaximized: z.boolean(),
});

const defaultWindowState: WindowState = {
  width: 1400,
  height: 900,
  isMaximized: false,
};

export function getWindowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

export function loadWindowState(): WindowState {
  try {
    const statePath = getWindowStatePath();
    if (fs.existsSync(statePath)) {
      const data = fs.readFileSync(statePath, 'utf-8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch (err) {
        console.error('[window-manager] window-state JSON parse failed:', err);
        return defaultWindowState;
      }
      const result = WindowStateSchema.safeParse(parsed);
      if (!result.success) {
        console.error('[window-manager] window-state schema validation failed:', result.error.issues);
        return defaultWindowState;
      }
      return { ...defaultWindowState, ...result.data };
    }
  } catch {
    console.error('Failed to load window state');
  }
  return defaultWindowState;
}

export function saveWindowState(win: BrowserWindow): void {
  try {
    const bounds = win.getBounds();
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized: win.isMaximized(),
    };
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(state, null, 2));
  } catch {
    console.error('Failed to save window state');
  }
}

export function getResourcePath(resource: string, isDev: boolean): string {
  if (isDev) {
    return path.join(__dirname, '../../../electron/resources', resource);
  } else {
    return path.join(app.getAppPath(), 'electron/resources', resource);
  }
}

export function getIconPath(isDev: boolean): string | undefined {
  const pngPath = getResourcePath('icon.png', isDev);
  if (fs.existsSync(pngPath)) {
    return pngPath;
  }
  if (process.platform === 'darwin') {
    const icnsPath = getResourcePath('icon.icns', isDev);
    if (fs.existsSync(icnsPath)) return icnsPath;
  } else if (process.platform === 'win32') {
    const icoPath = getResourcePath('icon.ico', isDev);
    if (fs.existsSync(icoPath)) return icoPath;
  }
  return undefined;
}

export function createMainWindow(isDev: boolean): BrowserWindow {
  const windowState = loadWindowState();

  const mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 800,
    minHeight: 600,
    title: 'Restura',
    ...(getIconPath(isDev) && { icon: getIconPath(isDev) }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
    show: false,
    backgroundColor: '#0a0a0a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 15, y: 15 },
  });

  if (windowState.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('close', () => {
    saveWindowState(mainWindow);
  });

  // Load the app
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    const indexPath = path.join(__dirname, '../../dist/web/client/index.html');
    mainWindow.loadFile(indexPath);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const { protocol } = new URL(url);
      if ((SAFE_OPEN_PROTOCOLS as readonly string[]).includes(protocol)) {
        shell.openExternal(url);
      }
    } catch { /* ignore malformed URLs */ }
    return { action: 'deny' };
  });

  // Create application menu
  const menu = createApplicationMenu(mainWindow);
  Menu.setApplicationMenu(menu);

  // Drop per-webContents rate-limit buckets when the renderer is destroyed.
  // Keeps the keyed-limiter Maps from accumulating dead webContents ids
  // across the app lifetime (windows opened/closed, reloads, etc.).
  bindLimiterToWebContents(
    [
      httpRateLimiter,
      grpcRateLimiter,
      wsRateLimiter,
      sseRateLimiter,
      mcpRateLimiter,
      notificationRateLimiter,
    ],
    mainWindow.webContents
  );

  return mainWindow;
}

export function registerNewWindowIPC(isDev: boolean): void {
  ipcMain.handle('window:new', async () => {
    createMainWindow(isDev);
  });
}
