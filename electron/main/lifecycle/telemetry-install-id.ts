/**
 * Random per-install ID for Sentry Release Health, so sessions can be counted as
 * installs rather than launches. See ADR-0040.
 *
 * It is a random UUID, never derived from hardware, the OS or the user, so it
 * can't be linked to anything outside Sentry's session data. It only exists once
 * the user has had a chance to opt out, and only while reporting is on: opting out
 * deletes it, and opting back in creates a new one.
 *
 * Stored as plain JSON in userData for the same reason as the consent flag: Sentry
 * inits before `safeStorage` is reliable, and this value is not a secret.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@shared/runtime/logger';
import { app } from 'electron';

const log = createLogger('telemetry-install-id');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function installIdFilePath(): string {
  return join(app.getPath('userData'), 'telemetry-install-id.json');
}

function readInstallId(): string | undefined {
  try {
    const { id } = JSON.parse(readFileSync(installIdFilePath(), 'utf8')) as { id?: unknown };
    return typeof id === 'string' && UUID_V4.test(id) ? id : undefined;
  } catch {
    // Missing is the normal first-run case; corrupt is replaced by the caller.
    return undefined;
  }
}

/**
 * Returns this install's ID, creating it on first use. Returns undefined if it
 * can't be saved: a new ID every launch would count one install as many users, so
 * sending no ID is the more accurate option.
 */
export function getOrCreateInstallId(): string | undefined {
  const existing = readInstallId();
  if (existing) return existing;

  const id = randomUUID();
  try {
    writeFileSync(installIdFilePath(), JSON.stringify({ id }), { encoding: 'utf8', mode: 0o600 });
    return id;
  } catch (error) {
    log.warn('failed to persist telemetry install id', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export function deleteInstallId(): void {
  try {
    rmSync(installIdFilePath(), { force: true });
  } catch (error) {
    log.warn('failed to delete telemetry install id', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
