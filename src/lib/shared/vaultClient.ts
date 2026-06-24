/**
 * Renderer-side wrapper for `pm.vault.{get,set,unset}` (Phase D).
 *
 * On desktop: routes through `window.electron.vault.*` IPC → encrypted
 * electron-store in the main process (`electron/main/storage/vault-handler.ts`).
 * The renderer never sees the encryption key.
 *
 * On web: rejects with a documented error. The Worker is stateless and
 * per-request — there's no place to durably store secrets the user
 * named with arbitrary keys. Capabilities matrix already marks
 * `scripts.vault` as desktop-only (Phase A); this message points users
 * at the alternatives (Restura Desktop or `pm.environment.set`).
 */
import type { PmVaultAdapter } from '@/features/scripts/lib/scriptExecutor';
import { isElectron } from '@/lib/shared/platform';

const WEB_NOT_AVAILABLE_MSG =
  'pm.vault is not available in the web build — open in Restura Desktop, or use pm.environment.set for in-session secrets.';

export function makeVaultAdapter(): PmVaultAdapter {
  if (isElectron()) {
    const v = window.electron?.vault;
    if (!v) {
      // Should never happen — the preload bridge always exposes electron.vault
      // when running inside Electron. The throw on get/set/unset is a
      // defensive fallback for forgotten-preload-binding regressions.
      return rejectingAdapter('window.electron.vault is not exposed');
    }
    return {
      async get(key: string) {
        const r = await v.get(key);
        return r.value ?? undefined;
      },
      async set(key: string, value: string) {
        await v.set(key, value);
      },
      async unset(key: string) {
        await v.unset(key);
      },
    };
  }
  return rejectingAdapter(WEB_NOT_AVAILABLE_MSG);
}

function rejectingAdapter(reason: string): PmVaultAdapter {
  return {
    async get() {
      throw new Error(reason);
    },
    async set() {
      throw new Error(reason);
    },
    async unset() {
      throw new Error(reason);
    },
  };
}
