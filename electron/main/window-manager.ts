import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '@shared/runtime/logger';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { z } from 'zod';
import { IPC } from '../shared/channels';
import type { KeyedRateLimiter } from './ipc/ipc-rate-limiter';
import { createValidatedHandler, NoInputSchema, SAFE_OPEN_PROTOCOLS } from './ipc/ipc-validators';
import { bindLimiterToWebContents } from './ipc/rate-limiter-cleanup';
import { createApplicationMenu } from './lifecycle/menu';
import { watchSmokeWindow } from './lifecycle/process-guard';
import { rendererGoneAction } from './lifecycle/renderer-recovery';

const log = createLogger('window-manager');

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized: boolean;
}

// Remembered separately from BrowserWindow.getFocusedWindow() because the
// latter returns null when the app is backgrounded — exactly the case
// auto-updater dialogs and tray clicks hit. lastFocusedWindow is set on
// each window's 'focus' event and survives a backgrounded app.
let lastFocusedWindow: BrowserWindow | null = null;

/**
 * Returns the renderer window UI surfaces should target: the focused window,
 * else the last-focused, else any live window. Replaces the legacy
 * single-window `getMainWindow` ref so multi-window scenarios (window:new
 * IPC, macOS dock activate) don't leave callers holding a destroyed handle.
 */
export function getActiveWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  if (lastFocusedWindow && !lastFocusedWindow.isDestroyed()) return lastFocusedWindow;
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;
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
        log.error('window-state JSON parse failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return defaultWindowState;
      }
      const result = WindowStateSchema.safeParse(parsed);
      if (!result.success) {
        log.error('window-state schema validation failed', { issues: result.error.issues });
        return defaultWindowState;
      }
      return { ...defaultWindowState, ...result.data };
    }
  } catch {
    log.error('failed to load window state');
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
    log.error('failed to save window state');
  }
}

// NOTE: this module MUST stay at electron/main/ root. The `__dirname`-relative
// paths here (resources, preload.js, web/index.html) are calibrated to the
// compiled location dist/electron/electron/main/; moving this file into a
// subdirectory adds a path segment and breaks them at runtime — and neither tsc
// nor the unit tests catch it (only a packaged/e2e run would).
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

const CASCADE_OFFSET = 30;

/**
 * Position for a new window. The first window uses the saved position; any
 * further window is offset from a live one so it doesn't open exactly on top.
 */
export function cascadePosition(
  saved: { x?: number; y?: number },
  reference: { x: number; y: number } | null
): { x?: number; y?: number } {
  if (!reference) return { x: saved.x, y: saved.y };
  return { x: reference.x + CASCADE_OFFSET, y: reference.y + CASCADE_OFFSET };
}

/**
 * window-state.json is a single file shared by every window; only the last
 * window to close writes it so a secondary window can't clobber the primary's.
 */
export function shouldPersistWindowState(otherLiveWindows: number): boolean {
  return otherLiveWindows === 0;
}

const rendererReloads = new WeakMap<BrowserWindow, number>();

/** A handler that fails to load must not stop the window from opening. */
function optionalLimiters(feature: string, load: () => KeyedRateLimiter[]): KeyedRateLimiter[] {
  try {
    return load();
  } catch (err) {
    log.error('startup feature failed', {
      feature,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return [];
  }
}

function windowLimiters(): KeyedRateLimiter[] {
  return [
    ...optionalLimiters('http', () => [require('./handlers/http-handler').httpRateLimiter]),
    ...optionalLimiters('grpc', () => [
      require('./handlers/grpc-handler').grpcRateLimiter,
      require('./handlers/grpc-handler').grpcStreamRateLimiter,
    ]),
    ...optionalLimiters('websocket', () => [
      require('./handlers/websocket-handler').wsRateLimiter,
      require('./handlers/websocket-handler').wsPingRateLimiter,
    ]),
    ...optionalLimiters('socketio', () => [
      require('./handlers/socketio-handler').socketIoRateLimiter,
    ]),
    ...optionalLimiters('sse', () => [require('./handlers/sse-handler').sseRateLimiter]),
    ...optionalLimiters('mcp', () => [
      require('./handlers/mcp-handler').mcpRateLimiter,
      require('./handlers/mcp-handler').mcpRequestRateLimiter,
      require('./handlers/mcp-handler').mcpCancelRateLimiter,
    ]),
    ...optionalLimiters('kafka', () => [require('./handlers/kafka-handler').kafkaRateLimiter]),
    ...optionalLimiters('mqtt', () => [require('./handlers/mqtt-handler').mqttRateLimiter]),
    ...optionalLimiters('git', () => [require('./handlers/git-handler').gitRateLimiter]),
    ...optionalLimiters('notifications', () => [
      require('./notifications').notificationRateLimiter,
    ]),
    ...optionalLimiters('secret-handles', () => [
      require('./security/secret-handle-store').secretRateLimiter,
    ]),
  ];
}

function attachRendererRecovery(win: BrowserWindow): void {
  win.webContents.on('render-process-gone', (_event, details) => {
    const previous = rendererReloads.get(win) ?? 0;
    const action = rendererGoneAction(previous, details.reason);
    log.error('renderer gone', { reason: details.reason, exitCode: details.exitCode, action });
    if (action === 'ignore' || win.isDestroyed()) return;
    if (action === 'reload') {
      rendererReloads.set(win, previous + 1);
      win.webContents.reload();
      return;
    }
    void dialog
      .showMessageBox(win, {
        type: 'error',
        title: 'Restura window crashed',
        message: 'This window crashed and could not recover automatically.',
        detail: 'Details were saved to the Restura log. You can reload the window or close it.',
        buttons: ['Reload', 'Close'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response !== 0 || win.isDestroyed()) return;
        rendererReloads.set(win, 0);
        win.webContents.reload();
      });
  });

  win.on('unresponsive', () => {
    log.error('renderer unresponsive');
    void dialog
      .showMessageBox(win, {
        type: 'warning',
        title: 'Restura is not responding',
        message: 'The window is not responding.',
        detail:
          'You can keep waiting, or reload the window. Details were saved to the Restura log.',
        buttons: ['Wait', 'Reload'],
        defaultId: 0,
        cancelId: 0,
      })
      .then(({ response }) => {
        if (response === 1 && !win.isDestroyed()) win.webContents.reload();
      });
  });
}

export function createMainWindow(isDev: boolean): BrowserWindow {
  const windowState = loadWindowState();
  const referenceWindow = getActiveWindow();
  const position = cascadePosition(
    windowState,
    referenceWindow ? referenceWindow.getBounds() : null
  );

  const mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: position.x,
    y: position.y,
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

  mainWindow.on('focus', () => {
    lastFocusedWindow = mainWindow;
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('close', () => {
    const others = BrowserWindow.getAllWindows().filter(
      (w) => w !== mainWindow && !w.isDestroyed()
    ).length;
    if (shouldPersistWindowState(others)) saveWindowState(mainWindow);
  });

  // Attach before loadFile/loadURL so a fast load cannot finish first.
  watchSmokeWindow(mainWindow);

  // Load the app
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    // Compiled main lives at dist/electron/electron/main/main.js; the Electron
    // renderer build (Cloudflare plugin skipped) emits the SPA to dist/web/.
    // electron-builder mirrors the project-relative tree into the asar, so the
    // renderer is three levels up from __dirname. (No `client/` subdir — that
    // only exists for the Cloudflare web build.)
    const indexPath = path.join(__dirname, '../../../web/index.html');
    mainWindow.loadFile(indexPath);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const { protocol } = new URL(url);
      if ((SAFE_OPEN_PROTOCOLS as readonly string[]).includes(protocol)) {
        shell.openExternal(url);
      }
    } catch {
      /* ignore malformed URLs */
    }
    return { action: 'deny' };
  });

  // Create application menu
  const menu = createApplicationMenu(mainWindow);
  Menu.setApplicationMenu(menu);

  // Drop per-webContents rate-limit buckets when the renderer is destroyed.
  // Keeps the keyed-limiter Maps from accumulating dead webContents ids
  // across the app lifetime (windows opened/closed, reloads, etc.).
  bindLimiterToWebContents(windowLimiters(), mainWindow.webContents);
  attachRendererRecovery(mainWindow);

  return mainWindow;
}

export function registerNewWindowIPC(isDev: boolean): void {
  ipcMain.handle(
    IPC.window.new,
    createValidatedHandler(IPC.window.new, NoInputSchema, async () => {
      createMainWindow(isDev);
    })
  );
}
