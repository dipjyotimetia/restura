// @vitest-environment node
//
// The store handler bridges renderer IPC to an encrypted electron-store. The
// store is instantiated lazily (real electron-store, ESM-only, can't be mocked
// through the source's require()), so we cover what runs without touching it:
// channel registration and the trust boundary (assertTrustedSender fires before
// getStoreInstance). The encrypted key policy is covered by encrypted-key.test.ts.
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  createElectronMock,
  untrustedEvent,
  getRegisteredHandler,
  silenceLogger,
} from './helpers/electron-mock';

vi.mock('electron', () => createElectronMock());
vi.mock('../../../src/lib/shared/logger', (orig) => silenceLogger(orig));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/channels';
import { registerStoreHandlerIPC } from '../store-handler';

type H = (e: unknown, ...a: unknown[]) => Promise<unknown>;
const h = (channel: string) => getRegisteredHandler(ipcMain, channel) as H;

describe('store-handler', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear();
    registerStoreHandlerIPC();
  });

  it('registers the store channels', () => {
    const channels = vi.mocked(ipcMain.handle).mock.calls.map((c) => c[0]);
    expect(channels).toEqual(
      expect.arrayContaining([
        IPC.store.get,
        IPC.store.set,
        IPC.store.delete,
        IPC.store.clear,
        IPC.store.has,
      ])
    );
  });

  it('rejects an untrusted sender before touching the store', async () => {
    await expect(h(IPC.store.get)(untrustedEvent(), 'token')).rejects.toThrow(/untrusted frame/i);
  });
});
