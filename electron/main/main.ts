import { app, BrowserWindow, session } from 'electron';
import { createLogger } from '@shared/runtime/logger';
import { registerAiHandlers, unregisterAiHandlers } from './handlers/ai-handler';
import { registerAiLabHandlers, unregisterAiLabHandlers } from './handlers/ai-lab-handler';
import { registerBugReportIPC } from './handlers/bug-report-handler';
import {
  registerCaptureBridgeIPC,
  stopCaptureBridge,
  unregisterCaptureBridgeIPC,
} from './handlers/capture-bridge-handler';
import { registerGitHandlerIPC, setGitDirectoryAllowlist } from './handlers/git-handler';
import { registerGrpcHandlerIPC, stopStreamCleanup } from './handlers/grpc-handler';
import { registerGrpcReflectionIPC } from './handlers/grpc-reflection-handler';
import { registerHttpHandlerIPC } from './handlers/http-handler';
import { registerKafkaHandlerIPC, stopKafkaCleanup } from './handlers/kafka-handler';
import { loadMcpDispatchContext } from './handlers/mcp-context-loader';
import { registerMcpHandlerIPC, stopMcpCleanup } from './handlers/mcp-handler';
import { startStdioMcpServer } from './handlers/mcp-server-handler';
import {
  registerMockServerIPC,
  stopMockServer,
  unregisterMockServerIPC,
} from './handlers/mock-server-handler';
import { registerMqttHandlerIPC, stopMqttCleanup } from './handlers/mqtt-handler';
import { registerSocketIoHandlerIPC, stopSocketIoCleanup } from './handlers/socketio-handler';
import { registerSseHandlerIPC, stopSseCleanup } from './handlers/sse-handler';
import { registerWebSocketHandlerIPC, stopWebSocketCleanup } from './handlers/websocket-handler';
import { registerAutoUpdaterIPC, setupAutoUpdater } from './lifecycle/auto-updater';
import { registerDeepLinkHandler } from './lifecycle/deep-link-handler';
import { initLogging } from './lifecycle/logging';
import { logRequest, registerRequestLoggerIPC } from './lifecycle/request-logger';
import { initSentry } from './lifecycle/sentry';
import { createSystemTray, destroyTray } from './lifecycle/system-tray';
import { readConsentSync, registerTelemetryConsentIPC } from './lifecycle/telemetry-consent';
import { registerWindowControlsIPC } from './lifecycle/window-controls';
import { registerNotificationIPC } from './notifications';
import { registerExecutionPolicyIPC } from './security/execution-policy';
import { registerKeychainStatusIPC } from './security/keychain-status-handler';
import { registerSecretHandleIPC, unregisterSecretHandleIPC } from './security/secret-handle-store';
import { registerBrunoExportHandlerIPC } from './storage/bruno-export-handler';
import {
  cleanupCollectionWatchers,
  isRegisteredCollectionDirectory,
  registerCollectionManagerIPC,
} from './storage/collection-manager';
import { registerFileOperationsIPC } from './storage/file-operations';
import { registerStoreHandlerIPC } from './storage/store-handler';
import { registerVaultHandlers, unregisterVaultHandlers } from './storage/vault-handler';
import { createMainWindow, getActiveWindow, registerNewWindowIPC } from './window-manager';

const isDev = process.env.NODE_ENV === 'development';

// Test harnesses (Playwright _electron) point this at a temp dir so test runs
// get isolated storage AND their own single-instance lock (the lock is keyed
// on the userData path, so a developer's running Restura won't kill the test
// launch). Must run before anything touches userData — logging, electron-store,
// and requestSingleInstanceLock below all derive from it.
if (process.env.RESTURA_USER_DATA_DIR) {
  app.setPath('userData', process.env.RESTURA_USER_DATA_DIR);
}

// Headless MCP-server mode (`restura --mcp-server`) — computed here, before
// initLogging, because the MCP SDK owns stdout for JSON-RPC and the console log
// transport must be forced off so it can't corrupt the stream (see logging.ts).
const isMcpServerMode = process.argv.includes('--mcp-server');

// Wire the shared logger to electron-log before anything logs, so module-init
// warnings and the global error handlers below are persisted from line one.
initLogging(isDev, { mcpServerMode: isMcpServerMode });

const log = createLogger('main');

// Initialize Sentry as early as possible — before window creation — so native
// crashes and main-process errors are armed from line one. @sentry/electron/main
// owns the native crashReporter (minidumps); it only inits when the user has
// opted in (read synchronously from the plain consent mirror), so opted-out
// users upload nothing. See electron/main/lifecycle/sentry.ts.
initSentry({ enabled: readConsentSync() });

// Sentry's default integrations already capture main-process uncaught
// exceptions/rejections; these handlers add structured local logging on top so
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
 * (`isMcpServerMode` is computed near the top, before initLogging.)
 */

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
  { register: () => registerBrunoExportHandlerIPC() },
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
  { register: () => registerTelemetryConsentIPC() },
  { register: () => registerExecutionPolicyIPC() },
  { register: () => registerBugReportIPC(getMainWindow) },
  { register: () => registerAiHandlers(), dispose: () => unregisterAiHandlers() },
  { register: () => registerAiLabHandlers(), dispose: () => unregisterAiLabHandlers() },
  {
    register: () => registerMockServerIPC(),
    dispose: async () => {
      await stopMockServer();
      unregisterMockServerIPC();
    },
  },
  {
    register: () => registerCaptureBridgeIPC(getMainWindow),
    dispose: async () => {
      await stopCaptureBridge();
      unregisterCaptureBridgeIPC();
    },
  },
];

// Register all IPC handlers
function registerIPCHandlers(): void {
  for (const mod of IPC_MODULES) mod.register();
}

// Setup Content Security Policy for production.
// NOTE: this policy is mirrored by the <meta> CSP fallback injected at build
// time in vite.config.mts (ELECTRON_RENDERER_CSP) — keep the two in sync.
// connect-src stays broad ('self' https: wss:) deliberately: the renderer
// talks directly to https origins in web-mode transport paths and Sentry.
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
              // Monaco workers are Vite `?worker` chunks loaded same-origin
              // (src/lib/shared/monaco-setup.ts) — no blob: needed.
              "worker-src 'self' file:; " +
              "object-src 'none'; " +
              "frame-ancestors 'none'; " +
              "base-uri 'self'; " +
              "form-action 'self';",
          ],
        },
      });
    });
  }
}

/**
 * Default-deny web permission handlers. Electron grants many permission
 * requests by default; the renderer needs almost none of them — every
 * privileged operation (notifications, filesystem, network) goes through the
 * validated IPC surface instead. The only web-platform permission the app
 * uses is `clipboard-sanitized-write` (navigator.clipboard.writeText behind
 * the copy buttons). Applied in dev and prod alike — unlike the CSP there is
 * no HMR reason to relax this.
 */
const ALLOWED_WEB_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write']);

function setupPermissionHandlers(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ALLOWED_WEB_PERMISSIONS.has(permission);
    if (!allowed) log.warn('permission request denied', { permission });
    callback(allowed);
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return ALLOWED_WEB_PERMISSIONS.has(permission);
  });
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

    // A 3xx redirect during an otherwise-allowed load can land on a new origin
    // without firing will-navigate — pair the same policy onto will-redirect.
    contents.on('will-redirect', (event, navigationUrl) => {
      if (isDev) {
        try {
          if (new URL(navigationUrl).origin === 'http://localhost:5173') return;
        } catch {
          /* fall through to block */
        }
        event.preventDefault();
        return;
      }
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
  if (isMcpServerMode) {
    // Headless: no window, no tray, no auto-updater. The MCP SDK owns stdio.
    // Anything that would log to stdout (`console.log`, banners) corrupts the
    // JSON-RPC stream — keep this branch minimal and route everything else to
    // stderr (which Claude Desktop captures into its log file).
    try {
      const handle = await startStdioMcpServer(() => loadMcpDispatchContext());
      // Tear the server down on quit so the parent process sees a clean EOF.
      // `preventDefault` + `app.exit()` after `handle.stop()` resolves
      // guarantees the stdio transport flushes before process exit — a
      // fire-and-forget `void` would race the default quit and could cut the
      // clean-EOF signal off. A timeout backstop bounds a hung transport.
      const MCP_STOP_TIMEOUT_MS = 3000;
      let mcpStopped = false;
      app.on('will-quit', (event) => {
        if (mcpStopped) return;
        event.preventDefault();
        void Promise.race([
          handle.stop().catch((err) => {
            log.error('mcp-server stop failed', {
              message: err instanceof Error ? err.message : String(err),
            });
          }),
          new Promise((resolve) => setTimeout(resolve, MCP_STOP_TIMEOUT_MS)),
        ]).then(() => {
          mcpStopped = true;
          app.exit(0);
        });
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
  setupPermissionHandlers();
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
// teardown can never silently fall out of sync with registration. Async
// disposes (Kafka/MQTT awaited broker closes) are awaited behind a
// preventDefault so graceful close isn't raced by process exit; a timeout
// backstop keeps a hung broker from blocking quit.
//
// MCP-server mode is excluded: `registerIPCHandlers()` never ran (the
// whenReady MCP branch returns early), so `IPC_MODULES` has nothing to
// dispose, and this handler's `app.exit(0)` would race (and typically
// pre-empt) the stdio transport teardown the MCP branch registers via
// `handle.stop()` — cutting off the clean EOF the parent process expects.
// The MCP branch owns its own `will-quit` shutdown.
if (!isMcpServerMode) {
  const QUIT_DISPOSE_TIMEOUT_MS = 3000;
  let quitCleanupDone = false;
  app.on('will-quit', (event) => {
    if (quitCleanupDone) return;
    event.preventDefault();
    const disposals = IPC_MODULES.filter((mod) => mod.dispose).map((mod) =>
      Promise.resolve()
        .then(() => mod.dispose!())
        .catch((err) => {
          log.error('IPC module dispose failed', {
            message: err instanceof Error ? err.message : String(err),
          });
        })
    );
    void Promise.race([
      Promise.allSettled(disposals),
      new Promise((resolve) => setTimeout(resolve, QUIT_DISPOSE_TIMEOUT_MS)),
    ]).then(() => {
      quitCleanupDone = true;
      destroyTray();
      app.exit(0);
    });
  });
}
