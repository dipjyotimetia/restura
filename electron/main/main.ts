import { app, BrowserWindow, ipcMain, dialog, shell, Menu, session } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { createApplicationMenu } from './menu';
import { autoUpdater } from 'electron-updater';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
const isDev = process.env.NODE_ENV === 'development';

// Configure auto-updater
function setupAutoUpdater(): void {
  if (isDev) {
    // Disable auto-updates in development
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    return;
  }

  // Configure auto-updater for production
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  // Log update events
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
      mainWindow.setProgressBar(-1); // Remove progress bar
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

  // Check for updates after a short delay
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('Failed to check for updates:', err);
    });
  }, 3000);
}

// IPC handler for manual update check
ipcMain.handle('app:checkForUpdates', async () => {
  if (isDev) {
    return { updateAvailable: false, message: 'Updates disabled in development' };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    return {
      updateAvailable: result?.updateInfo != null,
      version: result?.updateInfo?.version,
    };
  } catch (error) {
    return { updateAvailable: false, error: String(error) };
  }
});

// Get the correct path to resources depending on environment
function getResourcePath(resource: string): string {
  if (isDev) {
    // In development, resources are in the electron/resources directory
    return path.join(__dirname, '../../../electron/resources', resource);
  } else {
    // In production (packaged app), resources are at app root/electron/resources
    return path.join(app.getAppPath(), 'electron/resources', resource);
  }
}

// Get icon path with fallback
function getIconPath(): string | undefined {
  const pngPath = getResourcePath('icon.png');
  if (fs.existsSync(pngPath)) {
    return pngPath;
  }
  // Try platform-specific icons
  if (process.platform === 'darwin') {
    const icnsPath = getResourcePath('icon.icns');
    if (fs.existsSync(icnsPath)) return icnsPath;
  } else if (process.platform === 'win32') {
    const icoPath = getResourcePath('icon.ico');
    if (fs.existsSync(icoPath)) return icoPath;
  }
  // Return undefined to use default icon
  return undefined;
}

// Store window state
interface WindowState {
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

function getWindowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState(): WindowState {
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

function saveWindowState(win: BrowserWindow): void {
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

function createWindow(): void {
  const windowState = loadWindowState();

  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 800,
    minHeight: 600,
    title: 'Restura',
    ...(getIconPath() && { icon: getIconPath() }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true, // Always enabled for security
    },
    show: false, // Don't show until ready
    backgroundColor: '#0a0a0a', // Match dark theme
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 15, y: 15 },
  });

  // Restore maximized state
  if (windowState.isMaximized) {
    mainWindow.maximize();
  }

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Save window state on close
  mainWindow.on('close', () => {
    if (mainWindow) {
      saveWindowState(mainWindow);
    }
  });

  // Load the app
  if (isDev) {
    // In development, load from Next.js dev server
    mainWindow.loadURL('http://localhost:3000');
    // Open DevTools in development
    mainWindow.webContents.openDevTools();
  } else {
    // In production, load the static export
    const indexPath = path.join(__dirname, '../../out/index.html');
    mainWindow.loadFile(indexPath);
  }

  // Handle external links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Emitted when the window is closed.
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Create application menu
  const menu = createApplicationMenu(mainWindow);
  Menu.setApplicationMenu(menu);
}

// IPC Handlers for file operations
ipcMain.handle('dialog:openFile', async (_event, options) => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: options?.filters || [
      { name: 'JSON Files', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    ...options,
  });
  return result;
});

ipcMain.handle('dialog:saveFile', async (_event, options) => {
  if (!mainWindow) return null;
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: options?.filters || [
      { name: 'JSON Files', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    ...options,
  });
  return result;
});

// Security: Validate file path to prevent path traversal attacks
function isPathSafe(filePath: string): boolean {
  try {
    const normalizedPath = path.normalize(filePath);
    const userDataPath = app.getPath('userData');
    const documentsPath = app.getPath('documents');
    const homePath = app.getPath('home');

    // Block obvious path traversal attempts
    if (normalizedPath.includes('..') || normalizedPath.includes('~')) {
      return false;
    }

    // Block access to sensitive system directories
    const blockedPaths = [
      '/etc',
      '/usr',
      '/bin',
      '/sbin',
      '/var',
      '/root',
      '/System',
      '/Library',
      '/Applications',
      'C:\\Windows',
      'C:\\Program Files',
      'C:\\Program Files (x86)',
    ];

    for (const blocked of blockedPaths) {
      if (normalizedPath.toLowerCase().startsWith(blocked.toLowerCase())) {
        return false;
      }
    }

    // Allow access to user data directory, documents, and home directory
    const allowedPaths = [userDataPath, documentsPath, homePath];
    return allowedPaths.some((allowed) => normalizedPath.startsWith(allowed));
  } catch {
    return false;
  }
}

// Security: Limit file size to prevent memory exhaustion
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

ipcMain.handle('fs:readFile', async (_event, filePath: string) => {
  try {
    // Validate path for security
    if (!isPathSafe(filePath)) {
      return { success: false, error: 'Access denied: Path is outside allowed directories' };
    }

    // Check file size before reading
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_FILE_SIZE_BYTES) {
      return { success: false, error: `File too large: Maximum size is ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB` };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    return { success: true, content };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('fs:writeFile', async (_event, filePath: string, content: string) => {
  try {
    // Validate path for security
    if (!isPathSafe(filePath)) {
      return { success: false, error: 'Access denied: Path is outside allowed directories' };
    }

    // Check content size
    if (content.length > MAX_FILE_SIZE_BYTES) {
      return { success: false, error: `Content too large: Maximum size is ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB` };
    }

    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('app:getPath', (_event, name: string) => {
  return app.getPath(name as Parameters<typeof app.getPath>[0]);
});

ipcMain.handle('app:getVersion', () => {
  return app.getVersion();
});

ipcMain.handle('shell:openExternal', async (_event, url: string) => {
  await shell.openExternal(url);
});

// HTTP request handler with proxy support
interface ProxyConfig {
  enabled: boolean;
  type: string;
  host: string;
  port: number;
  auth?: {
    username: string;
    password: string;
  };
}

interface HttpRequestConfig {
  method: string;
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  data?: string;
  timeout?: number;
  maxRedirects?: number;
  proxy?: ProxyConfig;
  verifySsl?: boolean;
}

ipcMain.handle('http:request', async (_event, config: HttpRequestConfig) => {
  return new Promise((resolve, reject) => {
    try {
      // Parse URL and add query params
      const url = new URL(config.url);
      if (config.params) {
        Object.entries(config.params).forEach(([key, value]) => {
          url.searchParams.append(key, value);
        });
      }

      const isHttps = url.protocol === 'https:';

      // Build request options
      const requestOptions: http.RequestOptions | https.RequestOptions = {
        method: config.method || 'GET',
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: config.headers || {},
        timeout: config.timeout || 30000,
      };

      // Apply proxy settings
      if (config.proxy?.enabled && config.proxy.host) {
        // For HTTP proxy, we need to modify the request to go through the proxy
        if (config.proxy.type === 'http' || config.proxy.type === 'https') {
          requestOptions.hostname = config.proxy.host;
          requestOptions.port = config.proxy.port;
          requestOptions.path = url.href; // Full URL as path for proxy
          requestOptions.headers = {
            ...requestOptions.headers,
            Host: url.host,
          };

          // Add proxy authentication
          if (config.proxy.auth?.username && config.proxy.auth?.password) {
            const auth = Buffer.from(
              `${config.proxy.auth.username}:${config.proxy.auth.password}`
            ).toString('base64');
            (requestOptions.headers as Record<string, string>)['Proxy-Authorization'] = `Basic ${auth}`;
          }
        }
        // Note: SOCKS proxy support would require additional libraries like socks-proxy-agent
      }

      // Configure SSL verification
      if (isHttps && !config.verifySsl) {
        (requestOptions as https.RequestOptions).rejectUnauthorized = false;
      }

      // Create request
      const protocol = isHttps ? https : http;
      const req = protocol.request(requestOptions, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          // Parse response headers
          const headers: Record<string, string> = {};
          Object.entries(res.headers).forEach(([key, value]) => {
            if (typeof value === 'string') {
              headers[key] = value;
            } else if (Array.isArray(value)) {
              headers[key] = value.join(', ');
            }
          });

          // Try to parse JSON response
          let responseData: unknown = data;
          try {
            responseData = JSON.parse(data);
          } catch {
            // Keep as string if not valid JSON
          }

          resolve({
            status: res.statusCode || 0,
            statusText: res.statusMessage || '',
            headers,
            data: responseData,
          });
        });
      });

      // Handle errors
      req.on('error', (err) => {
        reject(new Error(`Request failed: ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      // Send request body if present
      if (config.data) {
        req.write(config.data);
      }

      req.end();
    } catch (err) {
      reject(err);
    }
  });
});

// Window control handlers
ipcMain.on('window:minimize', () => {
  mainWindow?.minimize();
});

ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});

ipcMain.on('window:close', () => {
  mainWindow?.close();
});

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
app.whenReady().then(() => {
  // Set Content Security Policy for production
  if (!isDev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self' file:; " +
              "script-src 'self' file: 'wasm-unsafe-eval'; " +
              "style-src 'self' 'unsafe-inline' file:; " +
              "img-src 'self' data: file: https:; " +
              "font-src 'self' data: file:; " +
              "connect-src 'self' https: wss:; " +
              "frame-ancestors 'none'; " +
              "base-uri 'self'; " +
              "form-action 'self';",
          ],
        },
      });
    });
  }

  createWindow();

  // Setup auto-updater after window is created
  setupAutoUpdater();

  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Security: Prevent navigation to external URLs
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);
    if (isDev && parsedUrl.origin === 'http://localhost:3000') {
      return;
    }
    if (parsedUrl.protocol === 'file:') {
      return;
    }
    event.preventDefault();
  });
});
