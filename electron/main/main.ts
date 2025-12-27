import { app, BrowserWindow, session, crashReporter } from 'electron';
import { setupAutoUpdater, registerAutoUpdaterIPC } from './auto-updater';
import { createMainWindow } from './window-manager';
import { registerFileOperationsIPC } from './file-operations';
import { registerHttpHandlerIPC } from './http-handler';
import { registerGrpcHandlerIPC, stopStreamCleanup } from './grpc-handler';
import { registerWindowControlsIPC } from './window-controls';
import { createSystemTray, destroyTray } from './system-tray';
import { registerNotificationIPC } from './notifications';
import { registerCollectionManagerIPC, cleanupCollectionWatchers } from './collection-manager';
import { registerStoreHandlerIPC } from './store-handler';

// Initialize crash reporter early (before app.whenReady)
crashReporter.start({
  productName: 'Restura',
  companyName: 'Restura',
  submitURL: '', // Set your crash report server URL here, or leave empty for local-only
  uploadToServer: false, // Set to true when you have a crash server configured
  ignoreSystemCrashHandler: false,
  compress: true,
  extra: {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  },
});

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
const isDev = process.env.NODE_ENV === 'development';

// Helper to get main window reference
const getMainWindow = (): BrowserWindow | null => mainWindow;

// Register all IPC handlers
function registerIPCHandlers(): void {
  registerAutoUpdaterIPC(isDev);
  registerFileOperationsIPC(getMainWindow);
  registerHttpHandlerIPC();
  registerGrpcHandlerIPC();
  registerWindowControlsIPC(getMainWindow);
  registerNotificationIPC(getMainWindow, isDev);
  registerCollectionManagerIPC(getMainWindow);
  registerStoreHandlerIPC();
}

// Content Security Policy configurations
// External resources needed:
// - Google Fonts: fonts.googleapis.com (stylesheets), fonts.gstatic.com (font files)
// - Monaco Editor: cdn.jsdelivr.net (editor scripts and workers)
const CSP_PRODUCTION = [
  "default-src 'self' file:",
  "script-src 'self' file: 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' file: https://fonts.googleapis.com",
  "img-src 'self' data: file: https:",
  "font-src 'self' data: file: https://fonts.gstatic.com",
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

// Development CSP allows Vite dev server, HMR websocket, and external resources
const CSP_DEVELOPMENT = [
  "default-src 'self' http://localhost:5173",
  // Allow inline scripts for Vite's HMR, Monaco Editor CDN for editor functionality
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5173 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  // Google Fonts stylesheets
  "style-src 'self' 'unsafe-inline' http://localhost:5173 https://fonts.googleapis.com",
  "img-src 'self' data: http://localhost:5173 https:",
  // Google Fonts font files
  "font-src 'self' data: http://localhost:5173 https://fonts.gstatic.com",
  // Allow localhost and websocket for HMR
  "connect-src 'self' http://localhost:5173 ws://localhost:5173 https: wss:",
  // Monaco Editor web workers
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' http://localhost:5173",
].join('; ');

/**
 * Setup Content Security Policy for both development and production
 * CSP is always enabled to ensure consistent security behavior
 */
function setupContentSecurityPolicy(): void {
  const cspPolicy = isDev ? CSP_DEVELOPMENT : CSP_PRODUCTION;

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [cspPolicy],
      },
    });
  });

  console.log(`[Security] CSP enabled (${isDev ? 'development' : 'production'} mode)`);
}

// Setup security measures
function setupSecurityMeasures(): void {
  // Prevent navigation to external URLs
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, navigationUrl) => {
      const parsedUrl = new URL(navigationUrl);
      if (isDev && parsedUrl.origin === 'http://localhost:5173') {
        return;
      }
      if (parsedUrl.protocol === 'file:') {
        return;
      }
      event.preventDefault();
    });
  });
}

// Initialize the application
app.whenReady().then(() => {
  setupContentSecurityPolicy();
  registerIPCHandlers();

  mainWindow = createMainWindow(isDev);

  // Handle window closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Setup auto-updater after window is created
  setupAutoUpdater(mainWindow, isDev);

  // Create system tray
  createSystemTray(mainWindow, isDev);

  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow(isDev);
    }
  });
});

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Cleanup on quit
app.on('will-quit', () => {
  stopStreamCleanup(); // Stop gRPC stream cleanup interval
  cleanupCollectionWatchers(); // Stop file watchers
  destroyTray();
});

// Setup security measures
setupSecurityMeasures();
