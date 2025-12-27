import { app, BrowserWindow, shell, Menu } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { createApplicationMenu } from './menu';

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized: boolean;
}

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
      return { ...defaultWindowState, ...JSON.parse(data) };
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
      preload: path.join(__dirname, '../preload/preload.js'),
      // Core security - these are critical
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      // Additional security hardening
      allowRunningInsecureContent: false, // Block HTTP content on HTTPS pages
      experimentalFeatures: false, // Disable experimental Chromium features
      navigateOnDragDrop: false, // Prevent navigation via drag and drop
      autoplayPolicy: 'user-gesture-required', // Require user interaction for media
      spellcheck: true, // Enable spellcheck for user input
      // Disable potentially dangerous features
      enableBlinkFeatures: '', // No experimental Blink features
      // Note: disableBlinkFeatures commented out as it may cause compatibility issues
      // disableBlinkFeatures: 'Auxclick', // Disable auxiliary click
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
    mainWindow.loadURL('http://localhost:5173'); // Vite dev server
    mainWindow.webContents.openDevTools();
  } else {
    // electron-vite outputs to dist/electron/renderer
    const indexPath = path.join(__dirname, '../renderer/index.html');
    mainWindow.loadFile(indexPath);
  }

  // Handle external links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Create application menu
  const menu = createApplicationMenu(mainWindow);
  Menu.setApplicationMenu(menu);

  return mainWindow;
}
