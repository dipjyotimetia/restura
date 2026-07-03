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
 *  - `sendDefaultPii: false`.
 *  - We only `Sentry.init()` when the user has opted in, so an opted-out user's
 *    native minidumps are never uploaded. In-session opt-in lazily inits (so JS
 *    capture works immediately); in-session opt-out closes the `beforeSend` gate
 *    for JS events — native capture stops on next launch (crashReporter can't be
 *    un-started mid-session).
 *  - `beforeSend`/`beforeBreadcrumb` run an aggressive scrubber that drops the
 *    request context, local frame variables, and breadcrumb data, and redacts
 *    secrets/file-paths from free-text strings (reusing the AI redaction core).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Sentry from '@sentry/electron/main';
import { redactBody } from '@shared/protocol/ai/redaction';
import { app } from 'electron';
import { createLogger } from '../../../src/lib/shared/logger';

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
  // No user identity is ever set (sendDefaultPii: false, no Sentry.setUser call),
  // but drop it defensively so a future integration or regression can't ship one.
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

function doInit(): void {
  if (initialized) return;
  const dsn = resolveDsn();
  if (!dsn) {
    log.warn('Sentry DSN not configured — error reporting disabled');
    return;
  }
  const isDev = process.env['NODE_ENV'] === 'development';
  Sentry.init({
    dsn,
    release: `restura@${app.getVersion()}`,
    environment: isDev ? 'development' : 'production',
    sendDefaultPii: false,
    // Release Health: track one anonymous session per main-process run (session
    // start/end, crash-free rate, version adoption) — the single aggregate
    // usage signal we collect on desktop, and how we gauge active users without
    // any device or user identifier. `@sentry/electron` enables this by default;
    // we list it explicitly so an SDK default change can't silently flip our one
    // usage signal on or off. Gated by the same opt-out as errors (we only
    // init() when opted in); sessions carry no IP (sendDefaultPii: false) and no
    // user id. Like native crash capture, a mid-session opt-out fully stops
    // sessions on next launch. See ADR-0027.
    integrations: [Sentry.mainProcessSessionIntegration()],
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
export function initSentry(opts: { enabled: boolean }): void {
  telemetryEnabled = opts.enabled;
  if (opts.enabled) doInit();
}

/**
 * Flip the runtime gate from the consent IPC handler. Enabling lazily inits
 * Sentry if it wasn't started at launch, so JS-event capture works immediately
 * (native minidump capture follows on next launch).
 */
export function setSentryEnabled(enabled: boolean): void {
  telemetryEnabled = enabled;
  if (enabled) doInit();
}
