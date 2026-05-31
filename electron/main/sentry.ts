/**
 * Main-process Sentry integration — crash + error reporting for the Electron
 * desktop target ONLY. Opt-in / default-off, mirroring the existing renderer
 * telemetry model (`settings.telemetry.errorsEnabled`).
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

import * as Sentry from '@sentry/electron/main';
import { app } from 'electron';
import { redactBody } from '@shared/protocol/ai/redaction';
import { createLogger } from '../../src/lib/shared/logger';

const log = createLogger('sentry');

// A DSN is not a secret (it's a public ingest identifier), so it's baked in to
// survive into the packaged app where `process.env` is absent. `SENTRY_DSN`
// overrides it for local/dev runs pointing at a throwaway project. Left empty
// until a project DSN is provisioned — `initSentry` no-ops without one. Read
// lazily inside `doInit` (not a module const) so it reflects the env at init.
const BAKED_IN_DSN = '';
function resolveDsn(): string {
  return process.env['SENTRY_DSN'] ?? BAKED_IN_DSN;
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

/** Strip request context, frame locals, breadcrumb data, and redact strings. */
export function scrubEvent<T extends Sentry.Event>(event: T): T {
  // Request context can carry the upstream URL, headers, and body — drop it.
  delete event.request;
  // Hostname can identify the user's machine.
  delete event.server_name;

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
  Sentry.init({
    dsn,
    release: `restura@${app.getVersion()}`,
    environment: process.env['NODE_ENV'] === 'development' ? 'development' : 'production',
    // Crash/error focus — no performance tracing for now.
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: (event) => (telemetryEnabled ? scrubEvent(event) : null),
    beforeBreadcrumb: (crumb) => {
      if (!telemetryEnabled) return null;
      delete crumb.data;
      if (crumb.message) crumb.message = scrubString(crumb.message);
      return crumb;
    },
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
