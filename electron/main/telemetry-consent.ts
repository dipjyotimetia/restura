/**
 * Plain (unencrypted) mirror of the renderer's telemetry opt-in flag.
 *
 * The canonical setting lives in the renderer's Zustand store, persisted to
 * Dexie/IndexedDB — which the main process cannot read. The encrypted
 * electron-store is also unusable here: its key needs `safeStorage`, which is
 * only reliable after `app.whenReady()`, whereas Sentry must init earlier. So
 * the renderer pushes the boolean here over IPC, and main reads it
 * synchronously at startup (a tiny JSON file in `userData`) to decide whether
 * to enable Sentry. A non-secret boolean does not warrant encryption.
 */

import { app, ipcMain } from 'electron';
import { z } from 'zod';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IPC } from '../shared/channels';
import { createValidatedHandler } from './ipc-validators';
import { setSentryEnabled } from './sentry';
import { createLogger } from '../../src/lib/shared/logger';

const log = createLogger('telemetry-consent');

// `app.getPath('userData')` resolves before `app.whenReady()`, so this is safe
// to read at the earliest point in main where Sentry inits.
function consentFilePath(): string {
  return join(app.getPath('userData'), 'telemetry-consent.json');
}

/** Read the persisted consent flag. Defaults to ON (opt-out) when unset. */
export function readConsentSync(): boolean {
  try {
    const raw = readFileSync(consentFilePath(), 'utf8');
    // Explicit opt-out persists `false`; anything else (incl. absent key) is on.
    return (JSON.parse(raw) as { errorsEnabled?: unknown }).errorsEnabled !== false;
  } catch {
    // Missing / unreadable / corrupt → on by default. Absence is the normal
    // first-run case (no consent file yet), so this is not logged.
    return true;
  }
}

function writeConsent(enabled: boolean): void {
  try {
    writeFileSync(consentFilePath(), JSON.stringify({ errorsEnabled: enabled }), 'utf8');
  } catch (error) {
    log.error('failed to persist telemetry consent', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const ConsentSchema = z.boolean();

/** Register the renderer→main consent push handler. Call after app is ready. */
export function registerTelemetryConsentIPC(): void {
  ipcMain.handle(
    IPC.telemetry.setConsent,
    createValidatedHandler(IPC.telemetry.setConsent, ConsentSchema, (enabled): { ok: true } => {
      writeConsent(enabled);
      setSentryEnabled(enabled);
      return { ok: true };
    })
  );
}
