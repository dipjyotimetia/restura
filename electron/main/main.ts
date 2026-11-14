import { createLogger } from '@shared/runtime/logger';
import { app, BrowserWindow, session } from 'electron';
import { setDevServerOriginTrusted } from './ipc/validators/boundary';
import { registerDeepLinkHandler } from './lifecycle/deep-link-handler';
import { failureFrom, type RunningFeature, startFeatures } from './lifecycle/feature-loader';
import { createDesktopFeatures } from './lifecycle/ipc-features';
import { initLogging } from './lifecycle/logging';
import { installProcessGuards, reportFeatureFailures } from './lifecycle/process-guard';
import { logRequest } from './lifecycle/request-logger';
import { endSentrySessionForQuit, initSentry } from './lifecycle/sentry';
import { hasRecordedConsentSync, readConsentSync } from './lifecycle/telemetry-consent';
import { primeStdioConsentMacKey } from './security/mcp-stdio-consent';
import { primeStoreKeys } from './security/store-keys';
import { createMainWindow, getActiveWindow } from './window-manager';

const isDev = process.env.NODE_ENV === 'development';

// IPC sender trust: the Vite dev-server origin (http://localhost:5173) is only
// trusted for an unpackaged dev run — a packaged build trusts nothing but its
// pinned file:// renderer entry, even if NODE_ENV=development leaks in. This is
// stricter than createMainWindow(isDev), which loads the dev URL on isDev alone,
// so such a build's window gets no IPC (fails closed).
setDevServerOriginTrusted(isDev && !app.isPackaged);

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
initSentry({ enabled: readConsentSync(), countSessions: hasRecordedConsentSync() });

// Sentry's default integrations already capture main-process uncaught
// exceptions/rejections. This extra listener logs them, points a dialog at
// the log file, and (because Electron shows its raw crash box only when it
// is the sole listener) replaces that box. A throw while a feature module
// is first imported never reaches here — those loads are deferred below.
installProcessGuards(log);

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
// Set when this process must not finish starting up (Squirrel install event,
// lost single-instance lock): `app.quit()` is asynchronous, so the whenReady
// chain checks this latch instead of priming keys, registering IPC and opening
// a window before the quit lands.
let quittingAtStartup = false;
if (require('electron-squirrel-startup')) {
  quittingAtStartup = true;
  app.quit();
}

/**
 * Headless MCP-server mode: when invoked as `restura --mcp-server`, we don't
 * create a window. This process is a stdio shim (ADR 0041): the launcher
 * (Claude Code, Claude Desktop, Codex, Cursor) parents it and speaks MCP over
 * stdin/stdout, and every tool call is relayed to the *running* desktop app's
 * loopback control server, which owns the data and enforces the user's
 * consent and approvals. The shim reads the port + token from the handshake
 * file under userData; it holds no user data of its own.
 * (`isMcpServerMode` is computed near the top, before initLogging.)
 */

// Helper to get the renderer window UI surfaces should target. Delegates to
// the window-manager registry so multi-window scenarios (window:new IPC,
// macOS dock activate) all return the currently-focused window instead of a
// stale reference to the first one we created.
const getMainWindow = (): BrowserWindow | null => getActiveWindow();

// Single instance lock — must be before app.whenReady(). The MCP stdio shim is
// exempt: it must run *alongside* the desktop app it relays to (and several
// agents may each spawn one), and it must not trigger the running app's
// `second-instance` handler.
if (!isMcpServerMode) {
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    quittingAtStartup = true;
    app.quit();
  } else {
    // Register deep-link handler before app.whenReady() so open-url / second-instance
    // events can fire even before the window is created
    // (requires single-instance lock to be requested before calling this)
    registerDeepLinkHandler(getMainWindow);
  }
}

// Register security measures early so all web-contents are protected from creation
setupSecurityMeasures();

// Features whose start() completed. A feature that throws while its module
// is first loaded is not in this list, so quit will not dispose it, and the
// failure does not abort the features after it.
const runningFeatures: RunningFeature[] = [];

function registerIPCHandlers(): { feature: string; message: string }[] {
  const failures: { feature: string; message: string; stack?: string }[] = [];
  runningFeatures.push(
    ...startFeatures(createDesktopFeatures({ isDev, getMainWindow, logRequest }), (failure) => {
      failures.push(failure);
      log.error('startup feature failed', {
        feature: failure.feature,
        message: failure.message,
        stack: failure.stack,
      });
    })
  );
  if (failures.length > 0) {
    log.error('startup degraded', { features: failures.map((failure) => failure.feature) });
    reportFeatureFailures(failures);
  }
  return failures;
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
              // sha256 = the no-flash theme script inlined in index.html (guarded by
              // security-hardening.test.ts; editing that script changes it).
              "script-src 'self' file: 'wasm-unsafe-eval' 'sha256-U5EOdU33K/f6G+BZlSv0efXEGlGSc66ZXxpGXfAM1Ec='; " +
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

app.whenReady().then(async () => {
  if (quittingAtStartup) return;
  if (isMcpServerMode) {
    // Headless: no window, no tray, no auto-updater, no store keys (the shim
    // opens no store — priming would cost a keychain prompt per agent launch).
    // The MCP SDK owns stdio. Anything that would log to stdout
    // (`console.log`, banners) corrupts the JSON-RPC stream — keep this branch
    // minimal and route everything else to stderr (which agents capture).
    try {
      const { startStdioMcpServer } =
        require('./handlers/mcp-server-handler') as typeof import('./handlers/mcp-server-handler');
      const handle = startStdioMcpServer({
        identity: { name: 'restura', version: app.getVersion() },
        userDataDir: app.getPath('userData'),
      });
      // Tear the server down on quit so the parent process sees a clean EOF.
      // `preventDefault` + `app.exit()` after `handle.stop()` resolves
      // guarantees the stdio transport flushes before process exit — a
      // fire-and-forget `void` would race the default quit and could cut the
      // clean-EOF signal off. A timeout backstop bounds a hung transport.
      const MCP_STOP_TIMEOUT_MS = 3000;
      let mcpStopped = false;
      let mcpStopping = false;
      app.on('will-quit', (event) => {
        if (mcpStopped) return;
        event.preventDefault();
        // A second quit while the stop is in flight waits for that one.
        if (mcpStopping) return;
        mcpStopping = true;
        void Promise.race([
          handle.stop().catch((err) => {
            log.error('mcp-server stop failed', {
              message: err instanceof Error ? err.message : String(err),
            });
          }),
          new Promise((resolve) => setTimeout(resolve, MCP_STOP_TIMEOUT_MS)),
        ]).then(async () => {
          mcpStopped = true;
          await endSentrySessionForQuit();
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

  // Derive every store key (async safeStorage) before anything can open a store.
  try {
    await Promise.all([primeStoreKeys(), primeStdioConsentMacKey()]);
  } catch (err) {
    log.error('failed to prime store keys', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  setupContentSecurityPolicy();
  setupPermissionHandlers();
  const startupFailures = registerIPCHandlers();

  // Collection watchers are owner-scoped: each is released when the webContents
  // that registered it goes away (collection-manager → bindRendererCleanup), so
  // closing one window never tears down another window's watchers / git
  // allowlist. The global cleanup runs only on quit (running feature dispose).
  createMainWindow(isDev);
  log.info('startup window created', {
    failedFeatures: startupFailures.map((failure) => failure.feature),
  });

  // Auto-updater resolves the target window lazily via getMainWindow so
  // dialogs land on the currently focused window — never a destroyed ref.
  try {
    const { setupAutoUpdater } =
      require('./lifecycle/auto-updater') as typeof import('./lifecycle/auto-updater');
    setupAutoUpdater(getMainWindow, isDev);
  } catch (err) {
    const failure = failureFrom('auto-updater', err);
    log.error('startup feature failed', {
      feature: failure.feature,
      message: failure.message,
      stack: failure.stack,
    });
  }

  try {
    const { createSystemTray } =
      require('./lifecycle/system-tray') as typeof import('./lifecycle/system-tray');
    createSystemTray(getMainWindow, isDev);
  } catch (err) {
    const failure = failureFrom('system-tray', err);
    log.error('startup feature failed', {
      feature: failure.feature,
      message: failure.message,
      stack: failure.stack,
    });
  }

  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(isDev);
    }
  });
});

app.on('child-process-gone', (_event, details) => {
  log.error('child process gone', {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    name: details.name,
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
// whenReady MCP branch returns early), so there is nothing to dispose, and
// this handler's `app.exit(0)` would race (and typically pre-empt) the stdio
// transport teardown the MCP branch registers via `handle.stop()` — cutting
// off the clean EOF the parent process expects. The MCP branch owns its own
// `will-quit` shutdown.
if (!isMcpServerMode) {
  const QUIT_DISPOSE_TIMEOUT_MS = 3000;
  let quitCleanupDone = false;
  let quitCleanupStarted = false;
  app.on('will-quit', (event) => {
    if (quitCleanupDone) return;
    event.preventDefault();
    // A second quit (Cmd+Q twice, tray Quit during shutdown) must not run every
    // dispose again: the first cleanup already ends in `app.exit(0)`.
    if (quitCleanupStarted) return;
    quitCleanupStarted = true;
    const disposals = runningFeatures.flatMap((feature) => {
      const stop = feature.stop;
      if (!stop) return [];
      return [
        Promise.resolve()
          .then(() => stop())
          .catch((err) => {
            log.error('startup feature dispose failed', {
              feature: feature.name,
              message: err instanceof Error ? err.message : String(err),
            });
          }),
      ];
    });
    void Promise.race([
      Promise.allSettled(disposals),
      new Promise((resolve) => setTimeout(resolve, QUIT_DISPOSE_TIMEOUT_MS)),
    ]).then(async () => {
      quitCleanupDone = true;
      try {
        const { destroyTray } =
          require('./lifecycle/system-tray') as typeof import('./lifecycle/system-tray');
        destroyTray();
      } catch (err) {
        const failure = failureFrom('system-tray', err);
        log.error('startup feature dispose failed', {
          feature: failure.feature,
          message: failure.message,
          stack: failure.stack,
        });
      }
      await endSentrySessionForQuit();
      app.exit(0);
    });
  });
}
