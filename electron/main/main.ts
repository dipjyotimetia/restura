import { app, BrowserWindow, session, crashReporter } from 'electron';
import { setupAutoUpdater, registerAutoUpdaterIPC } from './auto-updater';
import { createMainWindow, registerNewWindowIPC } from './window-manager';
import { registerFileOperationsIPC } from './file-operations';
import { registerHttpHandlerIPC } from './http-handler';
import { registerGrpcHandlerIPC, stopStreamCleanup } from './grpc-handler';
import { registerWebSocketHandlerIPC, stopWebSocketCleanup } from './websocket-handler';
import { registerSseHandlerIPC, stopSseCleanup } from './sse-handler';
import { registerMcpHandlerIPC, stopMcpCleanup } from './mcp-handler';
import { registerGrpcReflectionIPC } from './grpc-reflection-handler';
import { logRequest, registerRequestLoggerIPC } from './request-logger';
import { registerWindowControlsIPC } from './window-controls';
import { createSystemTray, destroyTray } from './system-tray';
import { registerNotificationIPC } from './notifications';
import { registerCollectionManagerIPC, cleanupCollectionWatchers } from './collection-manager';
import { registerStoreHandlerIPC } from './store-handler';
import { registerDeepLinkHandler } from './deep-link-handler';

// Initialize crash reporter early (before app.whenReady)
crashReporter.start({
  productName: 'Restura',
  companyName: 'Restura',
  submitURL: process.env['CRASH_REPORT_URL'] ?? '', // Set CRASH_REPORT_URL env var to enable crash reporting
  uploadToServer: !!process.env['CRASH_REPORT_URL'],
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

// Single instance lock — must be before app.whenReady()
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// Register deep-link handler before app.whenReady() so open-url / second-instance
// events can fire even before the window is created
// (requires single-instance lock to be requested before calling this)
registerDeepLinkHandler(getMainWindow);

// Register security measures early so all web-contents are protected from creation
setupSecurityMeasures();

// Register all IPC handlers
function registerIPCHandlers(): void {
  registerAutoUpdaterIPC(isDev);
  registerFileOperationsIPC(getMainWindow);
  registerHttpHandlerIPC(logRequest);
  registerGrpcHandlerIPC(logRequest);
  registerGrpcReflectionIPC();
  registerWebSocketHandlerIPC();
  registerSseHandlerIPC();
  registerMcpHandlerIPC();
  registerRequestLoggerIPC();
  registerWindowControlsIPC(getMainWindow);
  registerNewWindowIPC(isDev);
  registerNotificationIPC(getMainWindow, isDev);
  registerCollectionManagerIPC(getMainWindow);
  registerStoreHandlerIPC();
}

// Setup Content Security Policy for production
function setupContentSecurityPolicy(): void {
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
}

// Setup security measures
function setupSecurityMeasures(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, navigationUrl) => {
      // In dev allow only the Vite dev server origin
      if (isDev) {
        try {
          const parsedUrl = new URL(navigationUrl);
          if (parsedUrl.origin === 'http://localhost:5173') return;
        } catch { /* fall through to block */ }
        event.preventDefault();
        return;
      }
      // In production the SPA uses hash routing via loadFile — any will-navigate
      // event means something is trying to leave the app bundle; block it.
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
    cleanupCollectionWatchers(); // prevent watcher accumulation on macOS window re-create
  });

  // Setup auto-updater after window is created
  setupAutoUpdater(mainWindow, isDev);

  // Create system tray
  createSystemTray(getMainWindow, isDev);

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
  stopWebSocketCleanup(); // Close active WebSocket connections
  stopSseCleanup(); // Close active SSE connections
  stopMcpCleanup(); // Close active MCP connections
  cleanupCollectionWatchers(); // Stop file watchers
  destroyTray();
});

