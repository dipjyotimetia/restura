import { app, BrowserWindow, session, crashReporter } from 'electron';
import { setupAutoUpdater, registerAutoUpdaterIPC } from './auto-updater';
import { createMainWindow, getActiveWindow, registerNewWindowIPC } from './window-manager';
import { registerFileOperationsIPC } from './file-operations';
import { registerHttpHandlerIPC } from './http-handler';
import { registerGrpcHandlerIPC, stopStreamCleanup } from './grpc-handler';
import { registerWebSocketHandlerIPC, stopWebSocketCleanup } from './websocket-handler';
import { registerSocketIoHandlerIPC, stopSocketIoCleanup } from './socketio-handler';
import { registerSseHandlerIPC, stopSseCleanup } from './sse-handler';
import { registerMcpHandlerIPC, stopMcpCleanup } from './mcp-handler';
import { registerKafkaHandlerIPC, stopKafkaCleanup } from './kafka-handler';
import { registerMqttHandlerIPC, stopMqttCleanup } from './mqtt-handler';
import { registerGrpcReflectionIPC } from './grpc-reflection-handler';
import { logRequest, registerRequestLoggerIPC } from './request-logger';
import { registerWindowControlsIPC } from './window-controls';
import { createSystemTray, destroyTray } from './system-tray';
import { registerNotificationIPC } from './notifications';
import {
  registerCollectionManagerIPC,
  cleanupCollectionWatchers,
  isRegisteredCollectionDirectory,
} from './collection-manager';
import { registerStoreHandlerIPC, initStoreHandler } from './store-handler';
import {
  registerSecretHandleIPC,
  unregisterSecretHandleIPC,
  initSecretHandleStore,
} from './secret-handle-store';
import { registerVaultHandlers, unregisterVaultHandlers, initVaultStore } from './vault-handler';
import { registerKeychainStatusIPC } from './keychain-status-handler';
import { applyPermissionPolicy, denyWebContentsDeviceAccess } from './permission-policy';
import { setupCrashRecovery, logChildProcessExits } from './crash-recovery';
import { registerGitHandlerIPC, setGitDirectoryAllowlist } from './git-handler';
import { registerAiHandlers, unregisterAiHandlers } from './ai-handler';
import {
  registerMockServerIPC,
  unregisterMockServerIPC,
  stopMockServer,
} from './mock-server-handler';
import { registerDeepLinkHandler } from './deep-link-handler';
import { startStdioMcpServer } from './mcp-server-handler';
import { loadMcpDispatchContext } from './mcp-context-loader';
import { createLogger } from '../../src/lib/shared/logger';
import { initLogging } from './logging';

const isDev = process.env.NODE_ENV === 'development';

// Wire the shared logger to electron-log before anything logs, so module-init
// warnings and the global error handlers below are persisted from line one.
initLogging(isDev);

const log = createLogger('main');

// Initialize crash reporter early (before app.whenReady)
const crashReportUrl = process.env['CRASH_REPORT_URL'] ?? '';
crashReporter.start({
  productName: 'Restura',
  companyName: 'Restura',
  submitURL: crashReportUrl, // Set CRASH_REPORT_URL env var to enable crash reporting
  uploadToServer: !!crashReportUrl,
  ignoreSystemCrashHandler: false,
  compress: true,
  extra: {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  },
});

// Packaged builds without a crash submit URL silently lose native crashes.
// Warn loudly so operators notice the misconfig before users start hitting
// crashes that never reach the maintainers.
if (app.isPackaged && !crashReportUrl) {
  log.warn(
    'crashReporter is enabled but CRASH_REPORT_URL is unset — native crashes will not be reported'
  );
}

// crashReporter only captures native crashes; log JS-level failures so
// async paths (chokidar, dispatchers, stream errors) don't fail silently.
process.on('uncaughtException', (err, origin) => {
  log.error('uncaughtException', { origin, message: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

/**
 * Headless MCP-server mode: when invoked as `restura --mcp-server`, we don't
 * create a window. Instead we wire the MCP SDK to stdio and stream JSON-RPC
 * tool calls into the pure dispatcher. The launcher (Claude Desktop, Cursor,
 * Windsurf) parents the process and sends MCP-protocol messages over stdin.
 *
 * The user is in control of which surfaces are exposed via the per-collection /
 * per-environment / history consent settings persisted in the electron-store
 * `restura-encrypted-store`. `loadMcpDispatchContext()` reads those off disk
 * each tool call so the headless server always sees the latest user choices.
 */
const isMcpServerMode = process.argv.includes('--mcp-server');

// Helper to get the renderer window UI surfaces should target. Delegates to
// the window-manager registry so multi-window scenarios (window:new IPC,
// macOS dock activate) all return the currently-focused window instead of a
// stale reference to the first one we created.
const getMainWindow = (): BrowserWindow | null => getActiveWindow();

// Single instance lock — must be before app.whenReady()
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// Register deep-link handler before app.whenReady() so open-url / second-instance
// events can fire even before the window is created
// (requires single-instance lock to be requested before calling this)
registerDeepLinkHandler(getMainWindow);

// Force every renderer process-wide into the Chromium sandbox. Each BrowserWindow
// already sets `sandbox: true`, so this is a defense-in-depth backstop: a future
// window that forgets the flag still runs sandboxed. Must be called before ready.
app.enableSandbox();

// Register security measures early so all web-contents are protected from creation
setupSecurityMeasures();

/**
 * One IPC subsystem: its `register` side and (for handlers that hold long-lived
 * state — streams, watchers, listeners) its `dispose` side. Registration and
 * teardown iterate this single array, so a streaming handler structurally
 * cannot be registered without also wiring up its cleanup (the old failure mode
 * was two hand-ordered lists drifting apart and leaking on quit).
 */
interface IpcModule {
  register: () => void;
  dispose?: () => void | Promise<void>;
}

const IPC_MODULES: IpcModule[] = [
  { register: () => registerAutoUpdaterIPC(isDev) },
  { register: () => registerFileOperationsIPC(getMainWindow) },
  { register: () => registerHttpHandlerIPC(logRequest) },
  { register: () => registerGrpcHandlerIPC(logRequest), dispose: () => stopStreamCleanup() },
  { register: () => registerGrpcReflectionIPC() },
  { register: () => registerWebSocketHandlerIPC(), dispose: () => stopWebSocketCleanup() },
  { register: () => registerSocketIoHandlerIPC(), dispose: () => stopSocketIoCleanup() },
  { register: () => registerSseHandlerIPC(), dispose: () => stopSseCleanup() },
  { register: () => registerMcpHandlerIPC(), dispose: () => stopMcpCleanup() },
  { register: () => registerKafkaHandlerIPC(logRequest), dispose: () => stopKafkaCleanup() },
  { register: () => registerMqttHandlerIPC(logRequest), dispose: () => stopMqttCleanup() },
  { register: () => registerRequestLoggerIPC() },
  { register: () => registerWindowControlsIPC(getMainWindow) },
  { register: () => registerNewWindowIPC(isDev) },
  { register: () => registerNotificationIPC(getMainWindow, isDev) },
  {
    register: () => registerCollectionManagerIPC(getMainWindow),
    dispose: () => cleanupCollectionWatchers(),
  },
  { register: () => registerStoreHandlerIPC() },
  { register: () => registerSecretHandleIPC(), dispose: () => unregisterSecretHandleIPC() },
  { register: () => registerVaultHandlers(), dispose: () => unregisterVaultHandlers() },
  { register: () => registerKeychainStatusIPC() },
  {
    // Git operations are restricted to directories that are registered as
    // file-backed collections — `isRegisteredCollectionDirectory` consults the
    // active chokidar watchers in collection-manager.
    register: () => {
      setGitDirectoryAllowlist(isRegisteredCollectionDirectory);
      registerGitHandlerIPC();
    },
  },
  { register: () => registerAiHandlers(), dispose: () => unregisterAiHandlers() },
  {
    register: () => registerMockServerIPC(),
    dispose: () => {
      void stopMockServer();
      unregisterMockServerIPC();
    },
  },
];

// Register all IPC handlers
function registerIPCHandlers(): void {
  for (const mod of IPC_MODULES) mod.register();
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
  logChildProcessExits();

  app.on('web-contents-created', (_event, contents) => {
    setupCrashRecovery(contents);
    denyWebContentsDeviceAccess(contents);

    contents.on('will-navigate', (event, navigationUrl) => {
      // In dev allow only the Vite dev server origin
      if (isDev) {
        try {
          const parsedUrl = new URL(navigationUrl);
          if (parsedUrl.origin === 'http://localhost:5173') return;
        } catch {
          /* fall through to block */
        }
        event.preventDefault();
        return;
      }
      // In production the SPA uses hash routing via loadFile — any will-navigate
      // event means something is trying to leave the app bundle; block it.
      event.preventDefault();
    });

    // The app never embeds <webview>. Deny attachment so a compromised renderer
    // can't smuggle in a tag that loads remote content outside the sandbox.
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
  });
}

// Initialize the application
app.whenReady().then(async () => {
  // Prewarm the encrypted stores up front via the non-blocking async safeStorage
  // path, so the OS-keychain-backed key is derived in a single access at a
  // predictable moment. Runs in MCP mode too — headless secret resolution needs
  // the stores open. Failures are logged (not fatal); the sync self-init
  // accessors remain a fallback. safeStorage is only reliable post-`ready`.
  const prewarm = await Promise.allSettled([
    initStoreHandler(),
    initSecretHandleStore(),
    initVaultStore(),
  ]);
  for (const result of prewarm) {
    if (result.status === 'rejected') {
      log.error('encrypted store prewarm failed', {
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  if (isMcpServerMode) {
    // Headless: no window, no tray, no auto-updater. The MCP SDK owns stdio.
    // Anything that would log to stdout (`console.log`, banners) corrupts the
    // JSON-RPC stream — keep this branch minimal and route everything else to
    // stderr (which Claude Desktop captures into its log file).
    try {
      const handle = await startStdioMcpServer(() => loadMcpDispatchContext());
      // Tear the server down on quit so the parent process sees a clean EOF.
      app.on('will-quit', () => {
        void handle.stop();
      });
    } catch (err) {
      log.error('mcp-server start failed', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      app.quit();
    }
    return;
  }

  setupContentSecurityPolicy();
  applyPermissionPolicy(session.defaultSession);
  registerIPCHandlers();

  const initialWindow = createMainWindow(isDev);

  // Prevent watcher accumulation on macOS window re-create.
  initialWindow.on('closed', () => {
    cleanupCollectionWatchers();
  });

  // Auto-updater resolves the target window lazily via getMainWindow so
  // dialogs land on the currently focused window — never a destroyed ref.
  setupAutoUpdater(getMainWindow, isDev);

  // Create system tray
  createSystemTray(getMainWindow, isDev);

  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(isDev);
    }
  });
});

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Cleanup on quit — iterate the same registry the handlers registered from, so
// teardown can never silently fall out of sync with registration.
app.on('will-quit', () => {
  for (const mod of IPC_MODULES) {
    if (!mod.dispose) continue;
    try {
      void mod.dispose();
    } catch (err) {
      log.error('IPC module dispose failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  destroyTray();
});
