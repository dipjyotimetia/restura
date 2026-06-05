// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  createElectronMock,
  trustedEvent,
  untrustedEvent,
  getRegisteredHandler,
} from './helpers/electron-mock';

const { status } = vi.hoisted(() => ({
  status: {
    value: { mode: 'safeStorage', plaintextStores: [], lastChecked: '2026-01-01T00:00:00Z' },
  },
}));

vi.mock('electron', () => createElectronMock());
vi.mock('../encrypted-key', () => ({ getKeyStoreStatus: () => status.value }));

import { ipcMain, safeStorage } from 'electron';
import { IPC } from '../../shared/channels';
import { registerKeychainStatusIPC } from '../keychain-status-handler';

describe('keychain-status-handler', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear();
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
    registerKeychainStatusIPC();
  });

  it('registers keychain:status and keychain:rotate', () => {
    const channels = vi.mocked(ipcMain.handle).mock.calls.map((c) => c[0]);
    expect(channels).toEqual(expect.arrayContaining([IPC.keychain.status, IPC.keychain.rotate]));
  });

  it('returns the current key-store status to a trusted sender', async () => {
    const handler = getRegisteredHandler(ipcMain, IPC.keychain.status);
    expect(await handler(trustedEvent())).toEqual(status.value);
  });

  it('rejects status reads from an untrusted frame', async () => {
    const handler = getRegisteredHandler(ipcMain, IPC.keychain.status);
    await expect(handler(untrustedEvent())).rejects.toThrow(/untrusted frame/i);
  });

  it('rotate is a no-op that explains why when the keychain is unavailable', async () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);
    const rotate = getRegisteredHandler(ipcMain, IPC.keychain.rotate);
    const result = (await rotate(trustedEvent())) as { rotated: boolean; reason?: string };
    expect(result.rotated).toBe(false);
    expect(result.reason).toMatch(/still unavailable/i);
  });

  it('rotate is a no-op with a migration note when the keychain is available', async () => {
    const rotate = getRegisteredHandler(ipcMain, IPC.keychain.rotate);
    const result = (await rotate(trustedEvent())) as { rotated: boolean; reason?: string };
    expect(result.rotated).toBe(false);
    expect(result.reason).toMatch(/not implemented/i);
  });
});
