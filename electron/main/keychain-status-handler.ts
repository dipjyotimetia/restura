/**
 * IPC surface for the renderer to observe whether secrets are protected by the
 * OS keychain (safeStorage) or stored in a plaintext fallback. The renderer
 * shows a persistent banner when in plaintext mode so the user can fix the
 * situation (typically: install libsecret/gnome-keyring on Linux).
 *
 * Status is in-memory state owned by encrypted-key.ts and populated when each
 * electron-store opens its key. By the time the renderer's IPC call lands,
 * every store has already opened (main.ts:registerIPCHandlers runs first).
 *
 * `keychain:rotate` is a no-op when safeStorage is still unavailable; callers
 * use it as "re-check after install" after the user has installed a keyring
 * backend. A real re-encryption of existing electron-store records would
 * require draining and re-opening each store with a new key — out of scope
 * for v1; flagged in the plan.
 */

import { ipcMain, safeStorage } from 'electron';
import { getKeyStoreStatus, type KeyStoreStatus } from './encrypted-key';
import { IPC } from '../shared/channels';
import { assertTrustedSender } from './ipc-validators';

export interface RotateResult {
  rotated: boolean;
  status: KeyStoreStatus;
  /**
   * Human-readable reason returned when `rotated: false`. The renderer
   * surfaces this verbatim to the user so they understand whether the
   * keyring is missing, or the keyring is available but existing data
   * still needs migration.
   */
  reason?: string;
}

export function registerKeychainStatusIPC(): void {
  ipcMain.handle(IPC.keychain.status, async (event): Promise<KeyStoreStatus> => {
    assertTrustedSender(IPC.keychain.status, event);
    return getKeyStoreStatus();
  });

  ipcMain.handle(IPC.keychain.rotate, async (event): Promise<RotateResult> => {
    assertTrustedSender(IPC.keychain.rotate, event);
    // safeStorage availability is process-global; if it's still unavailable
    // there is nothing to rotate to. If it IS available, the existing
    // electron-store records were already encrypted with the *current* key
    // (either safeStorage-wrapped or plaintext fallback). Re-encrypting them
    // under a fresh safeStorage-wrapped key would require draining and
    // re-opening each store with a new key — intentionally out of scope.
    // We return `rotated: false` with an honest reason so the UI doesn't
    // imply work happened that didn't, and the user knows whether they
    // need to manually clear-and-reinitialise.
    const status = getKeyStoreStatus();
    if (!safeStorage.isEncryptionAvailable()) {
      return {
        rotated: false,
        status,
        reason: 'OS keychain (safeStorage) is still unavailable on this platform',
      };
    }
    return {
      rotated: false,
      status,
      reason:
        'Re-encryption of existing records is not implemented. Existing data is still protected by the current key; to migrate, clear the app data and re-enter secrets.',
    };
  });
}
