import { app, dialog } from 'electron';
import type { WebContents } from 'electron';
import * as Sentry from '@sentry/electron/main';
import { bindRendererCleanup } from './connection-cleanup';
import { createLogger } from '../../src/lib/shared/logger';

const log = createLogger('crash-recovery');

// crashReporter only captures *native* crashes; a renderer that dies
// (large-response OOM, GPU loss, WASM sandbox fault) otherwise leaves a
// dead/blank window. We auto-reload on genuine crashes, but cap reloads per
// webContents so a deterministic crash can't become an infinite reload loop.
const CRASH_WINDOW_MS = 30_000;
const MAX_RELOADS_PER_WINDOW = 3;
const crashTimestamps = new Map<number, number[]>();

/**
 * Per-webContents renderer crash recovery. Reloads a crashed renderer, but
 * trips a circuit-breaker (error dialog, no reload) once a window crashes more
 * than `MAX_RELOADS_PER_WINDOW` times within `CRASH_WINDOW_MS`.
 */
export function setupCrashRecovery(contents: WebContents): void {
  contents.on('render-process-gone', (_event, details) => {
    log.error('render-process-gone', { reason: details.reason, exitCode: details.exitCode });

    // Only recover from genuine crashes — not intentional teardown.
    if (details.reason !== 'crashed' && details.reason !== 'oom') return;

    // A dead renderer is not a JS throw, so Sentry's default integrations don't
    // see it — capture it explicitly. The opt-in gate is enforced in beforeSend.
    Sentry.captureMessage(`renderer ${details.reason}`, {
      level: 'fatal',
      tags: { kind: 'render-process-gone', reason: details.reason },
      extra: { exitCode: details.exitCode },
    });

    if (contents.isDestroyed()) return;

    const now = Date.now();
    const recent = (crashTimestamps.get(contents.id) ?? []).filter(
      (t) => now - t < CRASH_WINDOW_MS
    );
    recent.push(now);
    crashTimestamps.set(contents.id, recent);

    if (recent.length > MAX_RELOADS_PER_WINDOW) {
      log.error('render process crashed repeatedly — not reloading', { count: recent.length });
      dialog.showErrorBox(
        'Restura',
        'The application window crashed repeatedly and was not reloaded. Please restart Restura.'
      );
      return;
    }

    log.warn('reloading crashed renderer', { attempt: recent.length });
    contents.reload();
  });

  contents.on('unresponsive', () => log.warn('renderer unresponsive', { id: contents.id }));
  contents.on('responsive', () => log.info('renderer responsive again', { id: contents.id }));
  bindRendererCleanup(crashTimestamps, contents, (id) => crashTimestamps.delete(id));
}

/**
 * App-level visibility for GPU / utility / network child-process exits. Logging
 * only — no auto-action. Register once at startup.
 */
export function logChildProcessExits(): void {
  app.on('child-process-gone', (_event, details) => {
    log.error('child-process-gone', {
      type: details.type,
      reason: details.reason,
      name: details.name,
      exitCode: details.exitCode,
    });
    Sentry.captureMessage(`child process gone: ${details.type}`, {
      level: 'error',
      tags: { kind: 'child-process-gone', type: details.type, reason: details.reason },
      extra: { name: details.name, exitCode: details.exitCode },
    });
  });
}
