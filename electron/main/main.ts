import { app, BrowserWindow, session } from 'electron';
import { setupAutoUpdater, registerAutoUpdaterIPC } from './auto-updater';
import { createMainWindow } from './window-manager';
import { registerFileOperationsIPC } from './file-operations';
import { registerHttpHandlerIPC } from './http-handler';
import { registerGrpcHandlerIPC, stopStreamCleanup } from './grpc-handler';
import { registerWindowControlsIPC } from './window-controls';
import { createSystemTray, destroyTray } from './system-tray';
import { registerNotificationIPC } from './notifications';

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
  // Prevent navigation to external URLs
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
  destroyTray();
});

// Setup security measures
setupSecurityMeasures();
