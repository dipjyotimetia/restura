/**
 * Main-process Sentry integration — crash + error reporting ONLY for the Electron
 * desktop target. No performance tracing: we deliberately do not enable spans or
 * transactions (Restura proxies arbitrary user URLs through the main process, so
 * an http-client span would leak the user's private API endpoints). Opt-out /
 * default-on, mirroring the renderer telemetry model (`settings.telemetry.errorsEnabled`).
 *
 * `@sentry/electron/main`'s `init()` owns the native `crashReporter` (uploads
 * minidumps) and captures main-process uncaught exceptions/rejections via its
 * default integrations. The renderer SDK (`@sentry/electron/renderer`) forwards
 * its events here over IPC — no direct DSN network call from the sandbox.
 *
 * Privacy:
 *  - `dataCollection` opts out of every category (SDK 11 replaced `sendDefaultPii`;
 *    its defaults are permissive, so each is switched off explicitly).
 *  - We only `Sentry.init()` when the user has opted in, so an opted-out user's
 *    native minidumps are never uploaded. In-session opt-in lazily inits (so JS
 *    capture works immediately); in-session opt-out closes the `beforeSend` gate
 *    for JS events and drops the live session — native capture stops on next
 *    launch (crashReporter can't be un-started mid-session).
 *  - `beforeSend`/`beforeBreadcrumb` run an aggressive scrubber that drops the
 *    request context, local frame variables, and breadcrumb data, and redacts
 *    secrets/file-paths from free-text strings (reusing the AI redaction core).
 *  - Release Health sessions carry a random per-install ID so installs can be
 *    counted (ADR-0040). The scrubber strips it from error events, so an error
 *    can't be tied to an install.
 */

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as Sentry from '@sentry/electron/main';
import { redactBody } from '@shared/protocol/ai/redaction';
import { createLogger } from '@shared/runtime/logger';
import { app } from 'electron';
import { deleteInstallId, getOrCreateInstallId } from './telemetry-install-id';

const log = createLogger('sentry');

// The DSN is resolved at init time and is never hardcoded in source. Two
// sources, in priority order:
//   1. SENTRY_DSN env var — for dev (`SENTRY_DSN=… npm run electron:dev`).
//   2. `sentry.dsn` in the packaged package.json, injected at build time from a
//      CI secret via `npm pkg set sentry.dsn=…` (see .github/workflows/release.yml).
// A DSN is a public ingest identifier (not a secret), so shipping it inside the
// packaged package.json is fine. Empty → initSentry no-ops.
function resolveDsn(): string {
  const fromEnv = process.env['SENTRY_DSN'];
  if (fromEnv) return fromEnv;
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as {
      sentry?: { dsn?: string };
    };
    return pkg.sentry?.dsn ?? '';
  } catch {
    return '';
  }
}

// Runtime opt-in gate. `Sentry.init` runs at most once; this flag lets the
// in-session toggle (renderer → IPC) open/close JS-event reporting without a
// restart.
let telemetryEnabled = false;
let initialized = false;

export function isSentryEnabled(): boolean {
  return telemetryEnabled;
}

// Absolute paths leak usernames / machine layout — scrub them out of free-text
// strings (error messages, breadcrumbs). NB: we deliberately do NOT rewrite
// stack-frame `filename`/`abs_path`; Sentry normalises those to `app:///` and
// uses them to match uploaded source maps, and in packaged builds they point
// inside the app bundle (no username).
const FILE_PATH_PATTERNS: readonly RegExp[] = [
  /\/Users\/[^/\s)'"]+/g, // macOS
  /\/home\/[^/\s)'"]+/g, // Linux
  /[A-Za-z]:\\Users\\[^\\\s)'"]+/g, // Windows
];

function scrubString(value: string): string {
  let out = redactBody(value, 'default');
  for (const re of FILE_PATH_PATTERNS) out = out.replace(re, '[path]');
  return out;
}

/** Strip request context, user identity, frame locals, breadcrumb data, and redact strings. */
export function scrubEvent<T extends Sentry.Event>(event: T): T {
  // Request context can carry the upstream URL, headers, and body — drop it.
  delete event.request;
  // Hostname can identify the user's machine.
  delete event.server_name;
  // The scope's user holds the install ID, which is for sessions only. This delete
  // is what keeps it off error events, so an error can't be tied to an install.
  delete event.user;

  if (event.message) event.message = scrubString(event.message);

  for (const value of event.exception?.values ?? []) {
    if (value.value) value.value = scrubString(value.value);
    for (const frame of value.stacktrace?.frames ?? []) {
      // Local variables frequently hold secrets / request payloads.
      delete frame.vars;
    }
  }

  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.message) crumb.message = scrubString(crumb.message);
    // Network/navigation/console breadcrumb data holds URLs and bodies.
    delete crumb.data;
  }

  return event;
}

function doInit(countSessions: boolean): void {
  if (initialized) return;
  const dsn = resolveDsn();
  if (!dsn) {
    log.warn('Sentry DSN not configured — error reporting disabled');
    return;
  }
  const isDev = process.env['NODE_ENV'] === 'development';
  const installId = countSessions ? getOrCreateInstallId() : undefined;
  Sentry.init({
    dsn,
    release: `restura@${app.getVersion()}`,
    environment: isDev ? 'development' : 'production',
    // Must be initialScope, not setUser after init: the session integration starts
    // the session during init and copies the user from scope at that moment.
    initialScope: installId ? { user: { id: installId } } : {},
    // Equivalent of the pre-v8 `sendDefaultPii: false`, made explicit because the
    // new defaults collect user info, cookies, headers, bodies and frame vars.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    // Release Health: track one session per main-process run (session start/end,
    // crash-free rate, version adoption), tagged with the random install ID so
    // Sentry can count installs — our single usage signal on desktop.
    // `@sentry/electron` enables this by default; we list it explicitly so an SDK
    // default change can't silently flip it. `sendOnCreate` reports the session at
    // launch, because the default only sends it at quit, which undercounts apps that
    // stay open or get killed. Gated by the same opt-out as errors; sessions carry no
    // IP (dataCollection.userInfo: false). See ADR-0027 and ADR-0040.
    //
    // Holding the session until quit isn't enough to protect a first launch, because
    // the SDK also sends it on the first error. So until the user has had a chance to
    // opt out there is no session at all, which means removing the SDK's default one.
    integrations: countSessions
      ? [Sentry.mainProcessSessionIntegration({ sendOnCreate: true })]
      : (defaults) => defaults.filter((integration) => integration.name !== 'MainProcessSession'),
    // Crash/error reporting only — no performance tracing. We leave
    // `tracesSampleRate` unset so the SDK creates no spans or transactions: a
    // span could carry the user's proxied request URL, the exact data the error
    // scrubber strips. Default integrations still capture errors + crashes.
    beforeSend: (event) => (telemetryEnabled ? scrubEvent(event) : null),
    // Gate only — stop buffering breadcrumbs while opted out. Scrubbing happens
    // once, at send time, in scrubEvent (which loops over event.breadcrumbs).
    beforeBreadcrumb: (crumb) => (telemetryEnabled ? crumb : null),
    // Offline caching is on by default (queue persists across restarts). Flush
    // it at startup so a crash captured while offline uploads on the next launch
    // rather than waiting for the next event.
    transportOptions: { flushAtStartup: true },
  });
  initialized = true;
  log.info('Sentry initialized', { release: app.getVersion() });
}

/**
 * Initialise Sentry at startup. Only inits when the user has opted in, so an
 * opted-out user's native crashes are never uploaded. Call as early as possible
 * in main (before `crashReporter`/window creation) so native capture is armed.
 */
export function initSentry(opts: { enabled: boolean; countSessions: boolean }): void {
  telemetryEnabled = opts.enabled;
  if (opts.enabled) doInit(opts.countSessions);
  else forgetInstall();
}

/**
 * Delete the install ID and the SDK's cache. The cache holds copies of the ID (saved
 * scope, unfinished session, queued envelopes) that would otherwise link the periods
 * before and after an opt-out, and queued reports shouldn't upload after one.
 */
function forgetInstall(): void {
  deleteInstallId();
  try {
    rmSync(join(app.getPath('userData'), 'sentry'), { recursive: true, force: true });
  } catch (error) {
    log.warn('failed to delete Sentry cache', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const QUIT_FLUSH_TIMEOUT_MS = 2000;

/**
 * End the session on a clean quit. Call just before `app.exit()`, and await it.
 *
 * The SDK has its own will-quit handler for this, but it skips prevented events,
 * and main.ts prevents will-quit to await its async cleanup (a second `app.quit()`
 * from there hangs instead of re-firing the event). This does the same work: without
 * it, every clean quit reports as abnormal on the next launch.
 *
 * Never throws, and the flush is time-limited, so it can't stop the app quitting.
 */
export async function endSentrySessionForQuit(): Promise<void> {
  if (!initialized) return;
  try {
    if (Sentry.getIsolationScope().getSession()?.status === 'ok') Sentry.endSession();
    // The SDK's "still running" marker. Left in place, the next launch reports this
    // session as abnormal. The SDK doesn't export its own way of clearing it.
    rmSync(join(app.getPath('userData'), 'sentry', 'session.json'), { force: true });
    await Sentry.flush(QUIT_FLUSH_TIMEOUT_MS);
  } catch (error) {
    log.warn('failed to end Sentry session', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Flip the runtime gate from the consent IPC handler. Enabling lazily inits
 * Sentry if it wasn't started at launch, so JS-event capture works immediately
 * (native minidump capture follows on next launch).
 *
 * Enabling here is an explicit choice, so a lazy init does count sessions.
 *
 * Disabling drops the live session, since `beforeSend` doesn't gate sessions and it
 * would otherwise still ship with the ID at quit, then deletes every copy of the ID.
 * If the user re-enables in the same run, sessions resume on next launch with a new ID.
 */
export function setSentryEnabled(enabled: boolean): void {
  telemetryEnabled = enabled;
  if (enabled) {
    doInit(true);
    return;
  }
  if (initialized) {
    Sentry.getIsolationScope().setSession(undefined);
    // initialScope set the user on the current scope. Clear it or the SDK would
    // write it back into the cache deleted below.
    Sentry.getCurrentScope().setUser(null);
  }
  forgetInstall();
}
