/**
 * electron-store factory that never destroys an unreadable store file.
 *
 * conf 16 (electron-store 12) changed `clearInvalidConfig`: a READ of a store
 * that fails to decrypt / parse / validate now immediately overwrites the file
 * on disk, where conf 15 left it until the next write. Every encrypted store in
 * the app used `clearInvalidConfig: true`, so a wrong/rotated key (see
 * `security/encrypted-key.ts`) or a damaged file silently lost the user's data.
 *
 * `createResilientStore` constructs with `clearInvalidConfig: false`, probes the
 * file, and — only for the three "file is unreadable" error classes conf itself
 * would have cleared — renames the file to `<name>.corrupt-<ISO>.json` (keeping
 * the newest MAX_CORRUPT_BACKUPS) before constructing a fresh store. The backup
 * is still encrypted with whatever key wrote it; contents are never logged.
 * Any other error (EACCES, EBUSY, ...) is rethrown untouched.
 */

import { createLogger } from '@shared/runtime/logger';
import * as fs from 'fs';
import * as path from 'path';

const log = createLogger('resilient-store');

// electron-store is ESM-only; .default is the constructor under Node 22+.
const getStoreCtor = () => require('electron-store').default;

export const MAX_CORRUPT_BACKUPS = 3;

export interface ResilientStoreOptions {
  name: string;
  encryptionKey?: string;
  /** Absolute dir, or relative to userData. Defaults to userData. */
  cwd?: string;
  [key: string]: unknown;
}

export interface ResilientStore {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
  clear: () => void;
  has: (key: string) => boolean;
  store: Record<string, unknown>;
  path: string;
}

/** The errors conf's `clearInvalidConfig` would have wiped the file for. */
function isUnreadableFileError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'SyntaxError' ||
    err.constructor.name === 'DecryptionError' ||
    err.constructor.name === 'SchemaViolationError'
  );
}

function resolveStorePath(options: ResilientStoreOptions): string {
  const ext = typeof options['fileExtension'] === 'string' ? options['fileExtension'] : 'json';
  let dir = options.cwd;
  if (!dir || !path.isAbsolute(dir)) {
    const { app } = require('electron') as typeof import('electron');
    dir = options.cwd ? path.join(app.getPath('userData'), options.cwd) : app.getPath('userData');
  }
  return path.join(dir, ext ? `${options.name}.${ext}` : options.name);
}

function backupName(base: string, when: Date): string {
  return `${base}.corrupt-${when.toISOString().replace(/[:.]/g, '-')}.json`;
}

function backupUnreadableFile(file: string): void {
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));
  let when = new Date();
  // Fixed-width timestamps sort chronologically; bump the ms on collision so
  // ordering (and therefore pruning) stays correct and nothing is overwritten.
  while (fs.existsSync(path.join(dir, backupName(base, when)))) {
    when = new Date(when.getTime() + 1);
  }
  const target = backupName(base, when);
  fs.renameSync(file, path.join(dir, target));
  try {
    // The backup outlives the handle lifecycle; keep it owner-only.
    fs.chmodSync(path.join(dir, target), 0o600);
  } catch {
    // Best effort (e.g. filesystems without POSIX modes).
  }
  log.warn('unreadable store file preserved before reset', { store: base, backup: target });

  const prefix = `${base}.corrupt-`;
  const existing = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort();
  for (const old of existing.slice(0, Math.max(0, existing.length - MAX_CORRUPT_BACKUPS))) {
    try {
      fs.unlinkSync(path.join(dir, old));
    } catch {
      // Best-effort pruning.
    }
  }
}

function open(options: ResilientStoreOptions): ResilientStore {
  const Store = getStoreCtor();
  const store = new Store({ ...options, clearInvalidConfig: false }) as ResilientStore;
  // Constructing does not necessarily read; force one validated read.
  void store.store;
  return store;
}

export function createResilientStore<T = ResilientStore>(options: ResilientStoreOptions): T {
  try {
    return open(options) as T;
  } catch (err) {
    if (!isUnreadableFileError(err)) throw err;
    log.warn('store file unreadable (wrong key, corruption or schema violation)', {
      store: options.name,
      reason: err instanceof Error ? err.constructor.name : 'unknown',
    });
    try {
      backupUnreadableFile(resolveStorePath(options));
    } catch (backupErr) {
      // Refuse to open (and thereby overwrite) a file we could not preserve.
      log.error('could not back up unreadable store file; leaving it in place', {
        store: options.name,
        error: backupErr instanceof Error ? backupErr.message : String(backupErr),
      });
      throw err;
    }
    return open(options) as T;
  }
}
