/**
 * pm.vault backing store (Phase D).
 *
 * A user-named async key-value secret store that Postman v12 exposes as
 * `pm.vault.get/set/unset`. Distinct from the UUID-keyed
 * `secret-handle-store.ts` so a user-chosen vault key (e.g. "AWS_KEY")
 * cannot collide with an internally-generated handle UUID, and so we can
 * extend the vault later with its own access-control surface (per-script
 * confirmation toggle) without touching the auth-handle path.
 *
 * Same encryption envelope as the handle store: electron-store + a key
 * derived via `getOrCreateEncryptedKey` (which prefers the OS keychain
 * via safeStorage and falls back to a 0o600 file with a loud warning).
 *
 * The renderer reaches this through IPC; the channels are validated with
 * Zod in `ipc-validators.ts`. No `vault:resolve`-style escape hatch
 * exists — the only consumer of plaintext values is the renderer-side
 * `pm.vault.get` binding inside the QuickJS sandbox.
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '../../shared/channels';
import { createValidatedHandler, NoInputSchema } from '../ipc/ipc-validators';
import { getOrCreateEncryptedKey } from '../security/encrypted-key';
import { createResilientStore } from './resilient-store';

interface VaultRecord {
  value: string;
  updatedAt: number;
}

interface VaultStoreShape {
  get: (key: string) => VaultRecord | undefined;
  set: (key: string, value: VaultRecord) => void;
  delete: (key: string) => void;
  clear: () => void;
  has: (key: string) => boolean;
  store: Record<string, VaultRecord>;
}

let storeInstance: VaultStoreShape | null = null;

function getStore(): VaultStoreShape {
  if (storeInstance) return storeInstance;
  storeInstance = createResilientStore<VaultStoreShape>({
    name: 'restura-vault',
    encryptionKey: getOrCreateEncryptedKey({
      fileName: '.vault-key',
      storeLabel: 'pm.vault store',
    }),
  });
  return storeInstance;
}

// Vault key shape: 1–256 chars, no control characters. Tight enough to
// prevent silly collisions / log-injection while permitting natural names
// like `STRIPE_SECRET_KEY` and `my-team.api.token`.
const VAULT_KEY_RE = /^[^\x00-\x1F]+$/;
const vaultKey = z.string().min(1).max(256).regex(VAULT_KEY_RE);
export const VaultGetSchema = z.object({ key: vaultKey });
export const VaultSetSchema = z.object({ key: vaultKey, value: z.string().max(64 * 1024) });
export const VaultUnsetSchema = VaultGetSchema;

/** Test-only seam: inject a store (e.g. a real one in a temp dir). */
export function __setVaultStoreForTests(store: VaultStoreShape | null): void {
  storeInstance = store;
}

export type VaultFailure = { ok: false; error: string };

const INVALID_KEY_ERROR = 'Invalid vault key: not a valid key path';

/**
 * conf 16 resolves keys as dot-notation paths and throws a TypeError for a key
 * it cannot parse (for example `a[x`). Keys it accepts, including dotted nested
 * paths, keep mapping to the same stored data; only the unparseable ones are
 * turned into a clean failure instead of an unhandled IPC throw.
 */
function withKey<T>(op: () => T): T | VaultFailure {
  try {
    return op();
  } catch (err) {
    if (err instanceof TypeError) return { ok: false, error: INVALID_KEY_ERROR };
    throw err;
  }
}

export function vaultGet(key: string): { value: string | null } | (VaultFailure & { value: null }) {
  try {
    const rec = getStore().get(key);
    return rec ? { value: rec.value } : { value: null };
  } catch (err) {
    if (err instanceof TypeError) return { ok: false, error: INVALID_KEY_ERROR, value: null };
    throw err;
  }
}

export function vaultSet(key: string, value: string): { ok: true } | VaultFailure {
  return withKey(() => {
    getStore().set(key, { value, updatedAt: Date.now() });
    return { ok: true as const };
  });
}

export function vaultUnset(key: string): { ok: true } | VaultFailure {
  return withKey(() => {
    getStore().delete(key);
    return { ok: true as const };
  });
}

let registered = false;

export function registerVaultHandlers(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle(
    IPC.vault.get,
    createValidatedHandler(IPC.vault.get, VaultGetSchema, async ({ key }) => {
      return vaultGet(key);
    })
  );

  ipcMain.handle(
    IPC.vault.set,
    createValidatedHandler(IPC.vault.set, VaultSetSchema, async ({ key, value }) => {
      return vaultSet(key, value);
    })
  );

  ipcMain.handle(
    IPC.vault.unset,
    createValidatedHandler(IPC.vault.unset, VaultUnsetSchema, async ({ key }) => {
      return vaultUnset(key);
    })
  );

  ipcMain.handle(
    IPC.vault.clear,
    createValidatedHandler(IPC.vault.clear, NoInputSchema, async () => {
      getStore().clear();
      return { ok: true };
    })
  );
}

export function unregisterVaultHandlers(): void {
  if (!registered) return;
  ipcMain.removeHandler(IPC.vault.get);
  ipcMain.removeHandler(IPC.vault.set);
  ipcMain.removeHandler(IPC.vault.unset);
  ipcMain.removeHandler(IPC.vault.clear);
  registered = false;
}
