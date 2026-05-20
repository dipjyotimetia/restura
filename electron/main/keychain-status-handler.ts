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

export interface RotateResult {
  rotated: boolean;
  status: KeyStoreStatus;
}

export function registerKeychainStatusIPC(): void {
  ipcMain.handle('keychain:status', async (): Promise<KeyStoreStatus> => {
    return getKeyStoreStatus();
  });

  ipcMain.handle('keychain:rotate', async (): Promise<RotateResult> => {
    // safeStorage availability is process-global; if it's still unavailable
    // there is nothing to rotate to. Caller will see status.mode unchanged
    // and can prompt the user to install a keyring backend.
    const available = safeStorage.isEncryptionAvailable();
    return { rotated: available, status: getKeyStoreStatus() };
  });
}
