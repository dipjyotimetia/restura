import { app, BrowserWindow, session, crashReporter } from 'electron';
import { setupAutoUpdater, registerAutoUpdaterIPC } from './auto-updater';
import { createMainWindow } from './window-manager';
import { registerFileOperationsIPC } from './file-operations';
import { registerHttpHandlerIPC } from './http-handler';
import { registerGrpcHandlerIPC, stopStreamCleanup } from './grpc-handler';
import { registerWindowControlsIPC } from './window-controls';
import { createSystemTray, destroyTray } from './system-tray';
import { registerNotificationIPC } from './notifications';

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
}

// Setup Content Security Policy and Security Headers
function setupSecurityHeaders(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const securityHeaders: Record<string, string[]> = {
      // Prevent MIME type sniffing
      'X-Content-Type-Options': ['nosniff'],
      // Prevent clickjacking
      'X-Frame-Options': ['DENY'],
      // Control referrer information
      'Referrer-Policy': ['strict-origin-when-cross-origin'],
      // Prevent XSS attacks (legacy, but still useful)
      'X-XSS-Protection': ['1; mode=block'],
    };

    // Add CSP in production (more relaxed in dev for HMR)
    if (!isDev) {
      securityHeaders['Content-Security-Policy'] = [
        "default-src 'self' file:; " +
          "script-src 'self' file: 'wasm-unsafe-eval'; " +
          "style-src 'self' 'unsafe-inline' file:; " +
          "img-src 'self' data: file: https:; " +
          "font-src 'self' data: file:; " +
          "connect-src 'self' https: wss:; " +
          "frame-ancestors 'none'; " +
          "base-uri 'self'; " +
          "form-action 'self';",
      ];
    }

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        ...securityHeaders,
      },
    });
  });

  // Set up permission handling - deny all by default
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    // Only allow specific permissions
    const allowedPermissions = ['clipboard-read', 'clipboard-sanitized-write'];
    callback(allowedPermissions.includes(permission));
  });

  // Block navigation to external URLs
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    const allowedPermissions = ['clipboard-read', 'clipboard-sanitized-write'];
    return allowedPermissions.includes(permission);
  });
}

// Setup security measures
function setupSecurityMeasures(): void {
  // Prevent navigation to external URLs
  app.on('web-contents-created', (_event, contents) => {
    // Prevent navigation to untrusted URLs
    contents.on('will-navigate', (event, navigationUrl) => {
      const parsedUrl = new URL(navigationUrl);
      // Allow Vite dev server in development
      if (isDev && parsedUrl.origin === 'http://localhost:5173') {
        return;
      }
      // Allow file:// protocol for production builds
      if (parsedUrl.protocol === 'file:') {
        return;
      }
      // Block all other navigations
      event.preventDefault();
    });

    // Prevent new window creation (popups)
    contents.setWindowOpenHandler(({ url }) => {
      // Open external links in default browser
      if (url.startsWith('http://') || url.startsWith('https://')) {
        require('electron').shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    // Disable remote content
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
  });
}

// Initialize the application
app.whenReady().then(() => {
  setupSecurityHeaders();
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
