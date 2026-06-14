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
import { getOrCreateEncryptedKey } from '../security/encrypted-key';
import { createValidatedHandler } from '../ipc/ipc-validators';

// electron-store v9+ ESM-only; .default is the constructor under Node 22+.
const Store = require('electron-store').default;

interface VaultRecord {
  value: string;
  updatedAt: number;
}

interface VaultStoreShape {
  get: (key: string) => VaultRecord | undefined;
  set: (key: string, value: VaultRecord) => void;
  delete: (key: string) => void;
  has: (key: string) => boolean;
  store: Record<string, VaultRecord>;
}

let storeInstance: VaultStoreShape | null = null;

function getStore(): VaultStoreShape {
  if (storeInstance) return storeInstance;
  storeInstance = new Store({
    name: 'restura-vault',
    encryptionKey: getOrCreateEncryptedKey({
      fileName: '.vault-key',
      storeLabel: 'pm.vault store',
    }),
    clearInvalidConfig: true,
  }) as VaultStoreShape;
  return storeInstance;
}

// Vault key shape: 1–256 chars, no control characters. Tight enough to
// prevent silly collisions / log-injection while permitting natural names
// like `STRIPE_SECRET_KEY` and `my-team.api.token`.
// eslint-disable-next-line no-control-regex
const VAULT_KEY_RE = /^[^\x00-\x1F]+$/;
const vaultKey = z.string().min(1).max(256).regex(VAULT_KEY_RE);
export const VaultGetSchema = z.object({ key: vaultKey });
export const VaultSetSchema = z.object({ key: vaultKey, value: z.string().max(64 * 1024) });
export const VaultUnsetSchema = VaultGetSchema;

let registered = false;

export function registerVaultHandlers(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle(
    IPC.vault.get,
    createValidatedHandler(IPC.vault.get, VaultGetSchema, async ({ key }) => {
      const rec = getStore().get(key);
      return rec ? { value: rec.value } : { value: null };
    })
  );

  ipcMain.handle(
    IPC.vault.set,
    createValidatedHandler(IPC.vault.set, VaultSetSchema, async ({ key, value }) => {
      getStore().set(key, { value, updatedAt: Date.now() });
      return { ok: true };
    })
  );

  ipcMain.handle(
    IPC.vault.unset,
    createValidatedHandler(IPC.vault.unset, VaultUnsetSchema, async ({ key }) => {
      getStore().delete(key);
      return { ok: true };
    })
  );
}

export function unregisterVaultHandlers(): void {
  if (!registered) return;
  ipcMain.removeHandler(IPC.vault.get);
  ipcMain.removeHandler(IPC.vault.set);
  ipcMain.removeHandler(IPC.vault.unset);
  registered = false;
}
