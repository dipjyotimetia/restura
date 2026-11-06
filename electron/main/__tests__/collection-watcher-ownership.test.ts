// @vitest-environment node
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

const h = vi.hoisted(() => ({
  userData: '/tmp/x',
  handle: vi.fn(),
  watchers: [] as Array<{
    dir: string;
    listeners: Map<string, (filePath: string) => void>;
    close: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn((name: string) => (name === 'userData' ? h.userData : '/nonexistent')) },
  dialog: {},
  ipcMain: { handle: h.handle },
  shell: {},
}));

vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn((dir: string) => {
      const listeners = new Map<string, (filePath: string) => void>();
      const w = {
        dir,
        listeners,
        close: vi.fn(async () => undefined),
        on(event: string, cb: (filePath: string) => void) {
          listeners.set(event, cb);
          return w;
        },
      };
      h.watchers.push(w);
      return w;
    }),
  },
}));

import { EVENT, IPC } from '../../shared/channels';
import {
  cleanupCollectionWatchers,
  isRegisteredCollectionDirectory,
  registerCollectionManagerIPC,
} from '../storage/collection-manager';
import { resetGrantedCollectionRootsForTests } from '../storage/file-operations';

function fakeWebContents(id: number) {
  const once = new Map<string, Listener>();
  const wc = {
    id,
    destroyed: false,
    isDestroyed: () => wc.destroyed,
    on: vi.fn(),
    once: vi.fn((event: string, cb: Listener) => {
      once.set(event, cb);
    }),
    send: vi.fn(),
    destroy() {
      wc.destroyed = true;
      once.get('destroyed')?.();
    },
  };
  return wc;
}

function eventFrom(sender: ReturnType<typeof fakeWebContents>) {
  return { sender, senderFrame: { url: 'file:///app/dist/web/index.html', parent: null } };
}

function handlerFor(channel: string) {
  const call = h.handle.mock.calls.find(([c]) => c === channel);
  return call?.[1] as (event: unknown, ...args: unknown[]) => Promise<{ success: boolean }>;
}

describe('collection watchers are owned by the registering renderer', () => {
  let base: string;
  const focusedWindow = fakeWebContents(999);

  beforeEach(async () => {
    base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'watch-owner-')));
    h.userData = base;
    h.watchers.length = 0;
    resetGrantedCollectionRootsForTests();
    h.handle.mockClear();
    focusedWindow.send.mockClear();
    registerCollectionManagerIPC(() => ({ webContents: focusedWindow }) as never);
  });

  afterEach(async () => {
    cleanupCollectionWatchers();
    resetGrantedCollectionRootsForTests();
    await fsp.rm(base, { recursive: true, force: true });
  });

  it("destroying owner A releases only A's watchers; B keeps its watchers and git allowlist", async () => {
    const dirA = path.join(base, 'a');
    const dirB = path.join(base, 'b');
    const shared = path.join(base, 'shared');
    for (const d of [dirA, dirB, shared]) await fsp.mkdir(d);
    const ownerA = fakeWebContents(1);
    const ownerB = fakeWebContents(2);
    const watch = handlerFor(IPC.collection.watch);

    expect((await watch(eventFrom(ownerA), dirA)).success).toBe(true);
    expect((await watch(eventFrom(ownerA), shared)).success).toBe(true);
    expect((await watch(eventFrom(ownerB), dirB)).success).toBe(true);
    expect((await watch(eventFrom(ownerB), shared)).success).toBe(true);

    ownerA.destroy();

    expect(isRegisteredCollectionDirectory(dirA)).toBe(false);
    expect(isRegisteredCollectionDirectory(dirB)).toBe(true);
    // Still owned by B, so it stays in the git allowlist.
    expect(isRegisteredCollectionDirectory(shared)).toBe(true);

    ownerB.destroy();
    expect(isRegisteredCollectionDirectory(dirB)).toBe(false);
    expect(isRegisteredCollectionDirectory(shared)).toBe(false);
  });

  it('unwatch from one owner keeps a directory another owner still watches', async () => {
    const shared = path.join(base, 'shared');
    await fsp.mkdir(shared);
    const ownerA = fakeWebContents(1);
    const ownerB = fakeWebContents(2);
    await handlerFor(IPC.collection.watch)(eventFrom(ownerA), shared);
    await handlerFor(IPC.collection.watch)(eventFrom(ownerB), shared);

    await handlerFor(IPC.collection.unwatch)(eventFrom(ownerA), shared);
    expect(isRegisteredCollectionDirectory(shared)).toBe(true);

    await handlerFor(IPC.collection.unwatch)(eventFrom(ownerB), shared);
    expect(isRegisteredCollectionDirectory(shared)).toBe(false);
  });

  it('sends file events to the owning webContents, not the focused window', async () => {
    const dirB = path.join(base, 'b');
    await fsp.mkdir(dirB);
    const ownerA = fakeWebContents(1);
    const ownerB = fakeWebContents(2);
    await handlerFor(IPC.collection.watch)(eventFrom(ownerB), dirB);

    const watcher = h.watchers.at(-1);
    watcher?.listeners.get('add')?.(path.join(dirB, 'new.yml'));

    await vi.waitFor(() => expect(ownerB.send).toHaveBeenCalled(), { timeout: 2000 });
    expect(ownerB.send).toHaveBeenCalledWith(
      EVENT.collectionFileChanged,
      expect.objectContaining({ type: 'added', directoryPath: dirB })
    );
    expect(ownerA.send).not.toHaveBeenCalled();
    expect(focusedWindow.send).not.toHaveBeenCalled();
  });
});
