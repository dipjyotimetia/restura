import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEmitTo = vi.hoisted(() => vi.fn());
// Mock ipc-utils so the registry's emit is observable AND so its real `electron`
// import never loads. connection-cleanup is left REAL (it imports no electron at
// runtime), so these tests exercise the actual bindRendererCleanup/disposeByOwner
// wiring against a fake WebContents.
vi.mock('../ipc/ipc-utils', () => ({ emitTo: mockEmitTo }));

import { emitToEntry, type StreamEntryBase, StreamRegistry } from '../ipc/stream-registry';

interface FakeWc {
  id: number;
  isDestroyed: () => boolean;
  once: (evt: string, cb: () => void) => void;
}

/** Fake WebContents that records its 'destroyed' listener so a test can fire it. */
function makeWc(id: number): { wc: FakeWc; destroy: () => void } {
  let destroyed = false;
  const listeners: Array<() => void> = [];
  const wc: FakeWc = {
    id,
    isDestroyed: () => destroyed,
    once: (evt, cb) => {
      if (evt === 'destroyed') listeners.push(cb);
    },
  };
  return {
    wc,
    destroy: () => {
      destroyed = true;
      listeners.splice(0).forEach((cb) => cb());
    },
  };
}

interface TestEntry extends StreamEntryBase {
  connectionId: string;
  disposed: boolean;
}

function makeRegistry() {
  const disposed: string[] = [];
  const registry = new StreamRegistry<TestEntry>({
    prefixes: { message: 'test:message:', close: 'test:close:' },
    dispose: (e) => {
      e.disposed = true;
      disposed.push(e.connectionId);
    },
  });
  const entry = (connectionId: string, webContentsId: number): TestEntry => ({
    connectionId,
    webContentsId,
    disposed: false,
  });
  return { registry, disposed, entry };
}

describe('StreamRegistry', () => {
  let env: ReturnType<typeof makeRegistry>;
  beforeEach(() => {
    env = makeRegistry();
    mockEmitTo.mockClear();
  });

  it('stores entries and reports size / membership / per-sender counts', () => {
    const { registry, entry } = env;
    const a = makeWc(1);
    const b = makeWc(2);
    registry.add('c1', a.wc as never, entry('c1', 1));
    registry.add('c2', a.wc as never, entry('c2', 1));
    registry.add('c3', b.wc as never, entry('c3', 2));

    expect(registry.size()).toBe(3);
    expect(registry.has('c2', 1)).toBe(true);
    expect(registry.get('c3', 2)?.webContentsId).toBe(2);
    expect(registry.countForSender(1)).toBe(2);
    expect(registry.countForSender(2)).toBe(1);
  });

  it('returns an entry only to its owner', () => {
    const { registry, entry } = env;
    const owner = makeWc(1);
    registry.add('c1', owner.wc as never, entry('c1', 1));

    expect(registry.getForOwner('c1', 1)?.connectionId).toBe('c1');
    expect(registry.getForOwner('c1', 2)).toBeUndefined();
    expect(registry.getForOwner('missing', 2)).toBeUndefined();
  });

  it('stores the same external id independently per owner and cleans up only one owner', () => {
    const { registry, disposed, entry } = env;
    const first = makeWc(1);
    const second = makeWc(2);
    registry.add('shared', first.wc as never, entry('first', 1));
    registry.add('shared', second.wc as never, entry('second', 2));

    expect(registry.size()).toBe(2);
    expect(registry.get('shared', 1)?.connectionId).toBe('first');
    expect(registry.get('shared', 2)?.connectionId).toBe('second');

    first.destroy();
    expect(disposed).toEqual(['first']);
    expect(registry.has('shared', 1)).toBe(false);
    expect(registry.has('shared', 2)).toBe(true);
  });

  it('replaces (and disposes) an existing entry registered under the same id', () => {
    const { registry, disposed, entry } = env;
    const wc = makeWc(1);
    const first = entry('c1', 1);
    registry.add('c1', wc.wc as never, first);
    registry.add('c1', wc.wc as never, entry('c1', 1));

    expect(first.disposed).toBe(true);
    expect(disposed).toEqual(['c1']);
    expect(registry.size()).toBe(1); // not duplicated
  });

  it('replaces only the owner entry and hides non-owner entries as missing', () => {
    const { registry, disposed, entry } = env;
    const owner = makeWc(1);
    const first = entry('c1', 1);
    registry.add('c1', owner.wc as never, first);

    const nonOwnerReplacement = entry('c1', 2);
    expect(registry.replaceForOwner('c1', 2, nonOwnerReplacement)).toBe(false);
    expect(registry.replaceForOwner('missing', 2, nonOwnerReplacement)).toBe(false);
    expect(registry.get('c1', 1)).toBe(first);
    expect(first.disposed).toBe(false);
    expect(disposed).toEqual([]);

    const ownerReplacement = entry('c1', 1);
    expect(registry.replaceForOwner('c1', 1, ownerReplacement)).toBe(true);
    expect(registry.get('c1', 1)).toBe(ownerReplacement);
    expect(first.disposed).toBe(true);
    expect(disposed).toEqual(['c1']);

    owner.destroy();
    expect(ownerReplacement.disposed).toBe(true);
    expect(registry.has('c1', 1)).toBe(false);
  });

  it('rejects a replacement entry tagged to a different owner', () => {
    const { registry, disposed, entry } = env;
    const owner = makeWc(1);
    const first = entry('c1', 1);
    registry.add('c1', owner.wc as never, first);

    expect(registry.replaceForOwner('c1', 1, entry('c1', 2))).toBe(false);
    expect(registry.get('c1', 1)).toBe(first);
    expect(first.disposed).toBe(false);
    expect(disposed).toEqual([]);
  });

  it('tryAdd() stores a new id but rejects a duplicate without disposing', () => {
    const { registry, disposed, entry } = env;
    const wc = makeWc(1);
    expect(registry.tryAdd('c1', wc.wc as never, entry('c1', 1))).toBe(true);
    const dup = entry('c1', 1);
    expect(registry.tryAdd('c1', wc.wc as never, dup)).toBe(false);
    expect(dup.disposed).toBe(false); // existing entry untouched, no dispose
    expect(disposed).toEqual([]);
    expect(registry.size()).toBe(1);
  });

  it('remove() drops an entry without disposing it', () => {
    const { registry, disposed, entry } = env;
    const wc = makeWc(1);
    const e = entry('c1', 1);
    registry.add('c1', wc.wc as never, e);
    registry.remove('c1', 1);
    expect(registry.has('c1', 1)).toBe(false);
    expect(e.disposed).toBe(false);
    expect(disposed).toEqual([]);
  });

  it('cancel() disposes + removes and reports whether the entry existed', () => {
    const { registry, disposed, entry } = env;
    const wc = makeWc(1);
    registry.add('c1', wc.wc as never, entry('c1', 1));
    expect(registry.cancel('c1', 1)).toBe(true);
    expect(registry.has('c1', 1)).toBe(false);
    expect(disposed).toEqual(['c1']);
    expect(registry.cancel('missing', 1)).toBe(false);
  });

  it('cancels only the owner entry and hides non-owner entries as missing', () => {
    const { registry, disposed, entry } = env;
    const owner = makeWc(1);
    registry.add('c1', owner.wc as never, entry('c1', 1));

    expect(registry.cancelForOwner('c1', 2)).toBe(false);
    expect(registry.cancelForOwner('missing', 2)).toBe(false);
    expect(registry.get('c1', 1)?.webContentsId).toBe(1);
    expect(disposed).toEqual([]);

    expect(registry.cancelForOwner('c1', 1)).toBe(true);
    expect(registry.has('c1', 1)).toBe(false);
    expect(disposed).toEqual(['c1']);
  });

  it('emit() targets the owning renderer with a templated channel; no-ops when gone', () => {
    const { registry, entry } = env;
    const wc = makeWc(7);
    registry.add('c1', wc.wc as never, entry('c1', 7));
    registry.emit('c1', 7, 'message', { hello: 'world' });
    expect(mockEmitTo).toHaveBeenCalledWith(7, 'test:message:c1', { hello: 'world' });

    mockEmitTo.mockClear();
    registry.emit('c1', 7, 'unknown-event', {}); // event name not in prefixes
    registry.emit('missing', 7, 'message', {}); // entry gone
    expect(mockEmitTo).not.toHaveBeenCalled();
  });

  it('emitAndRemove() emits the terminal event and then drops the entry', () => {
    const { registry, entry } = env;
    const wc = makeWc(7);
    registry.add('c1', wc.wc as never, entry('c1', 7));
    registry.emitAndRemove('c1', 7, 'close', { reason: 'done' });
    // Emitted to the live entry, then removed.
    expect(mockEmitTo).toHaveBeenCalledWith(7, 'test:close:c1', { reason: 'done' });
    expect(registry.has('c1', 7)).toBe(false);
    // A second emit for the same id is now a no-op (entry gone) — the foot-gun
    // emitAndRemove exists to prevent.
    mockEmitTo.mockClear();
    registry.emit('c1', 7, 'close', { reason: 'again' });
    expect(mockEmitTo).not.toHaveBeenCalled();
  });

  it('disposes exactly the destroyed renderer’s entries on renderer cleanup', () => {
    const { registry, disposed, entry } = env;
    const a = makeWc(1);
    const b = makeWc(2);
    registry.add('a1', a.wc as never, entry('a1', 1));
    registry.add('a2', a.wc as never, entry('a2', 1));
    registry.add('b1', b.wc as never, entry('b1', 2));

    a.destroy();

    expect(disposed.sort()).toEqual(['a1', 'a2']);
    expect(registry.has('a1', 1)).toBe(false);
    expect(registry.has('a2', 1)).toBe(false);
    expect(registry.has('b1', 2)).toBe(true); // other renderer untouched
    expect(registry.size()).toBe(1);
  });

  it('values() iterates live entries and clear() drops them without disposing', () => {
    const { registry, disposed, entry } = env;
    const wc = makeWc(1);
    registry.add('c1', wc.wc as never, entry('c1', 1));
    registry.add('c2', wc.wc as never, entry('c2', 1));
    expect([...registry.values()].map((e) => e.connectionId).sort()).toEqual(['c1', 'c2']);
    registry.clear();
    expect(registry.size()).toBe(0);
    expect(disposed).toEqual([]); // clear() must NOT dispose
  });

  it('disposeAll() tears down everything and clears', () => {
    const { registry, disposed, entry } = env;
    const wc = makeWc(1);
    registry.add('c1', wc.wc as never, entry('c1', 1));
    registry.add('c2', wc.wc as never, entry('c2', 1));
    registry.disposeAll();
    expect(disposed.sort()).toEqual(['c1', 'c2']);
    expect(registry.size()).toBe(0);
  });

  it('swallows a throwing dispose so cleanup never explodes', () => {
    const registry = new StreamRegistry<TestEntry>({
      dispose: () => {
        throw new Error('boom');
      },
    });
    const wc = makeWc(1);
    registry.add('c1', wc.wc as never, { connectionId: 'c1', webContentsId: 1, disposed: false });
    expect(() => registry.cancel('c1', 1)).not.toThrow();
    expect(() => registry.disposeAll()).not.toThrow();
  });
});

/** Fake WebContents that counts listeners and can fire destroy / document-reset. */
function makeCountingWc(id: number, opts: { destroyed?: boolean } = {}) {
  let destroyed = opts.destroyed ?? false;
  const destroyedListeners: Array<() => void> = [];
  const resetListeners: Array<() => void> = [];
  const wc = {
    id,
    isDestroyed: () => destroyed,
    once: (evt: string, cb: () => void) => {
      if (evt === 'destroyed') destroyedListeners.push(cb);
    },
    on: (evt: string, cb: () => void) => {
      if (evt === 'did-navigate') resetListeners.push(cb);
    },
    send: vi.fn(),
  };
  return {
    wc,
    destroyedListenerCount: () => destroyedListeners.length,
    reload: () => {
      for (const cb of resetListeners) cb();
    },
    destroy: () => {
      destroyed = true;
      for (const cb of destroyedListeners.splice(0)) cb();
    },
  };
}

interface TestClaimFields {
  abort?: AbortController;
  resource?: string;
}

describe('StreamRegistry claims', () => {
  function setup() {
    const disposedClaims: Array<string | undefined> = [];
    const disposedEntries: string[] = [];
    const registry = new StreamRegistry<TestEntry, TestClaimFields>({
      dispose: (e) => {
        e.disposed = true;
        disposedEntries.push(e.connectionId);
      },
      disposeClaim: (claim) => {
        claim.abort?.abort();
        disposedClaims.push(claim.resource);
      },
    });
    const entry = (connectionId: string, webContentsId: number): TestEntry => ({
      connectionId,
      webContentsId,
      disposed: false,
    });
    return { registry, disposedClaims, disposedEntries, entry };
  }

  it('does not collide when two renderers reserve the same id', () => {
    const { registry } = setup();
    const a = registry.reserveClaim('shared', makeCountingWc(1).wc as never)!;
    const b = registry.reserveClaim('shared', makeCountingWc(2).wc as never)!;

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(registry.pendingCount()).toBe(2);
    expect(registry.isClaimLive(a)).toBe(true);
    expect(registry.isClaimLive(b)).toBe(true);
    expect(registry.claimFor('shared', 1)).toBe(a);
    expect(registry.claimFor('shared', 2)).toBe(b);
    expect(registry.claimFor('shared', 3)).toBeUndefined();

    registry.releaseClaim(a);
    expect(registry.isClaimLive(a)).toBe(false);
    expect(registry.isClaimLive(b)).toBe(true);
  });

  it('refuses a second reserve for the same owner + id and leaves the first untouched', () => {
    const { registry, disposedClaims } = setup();
    const { wc } = makeCountingWc(1);
    const first = registry.reserveClaim('c1', wc as never, { resource: 'first' })!;

    expect(registry.reserveClaim('c1', wc as never, { resource: 'second' })).toBeUndefined();
    expect(registry.isClaimLive(first)).toBe(true);
    expect(registry.claimFor('c1', 1)?.resource).toBe('first');
    expect(registry.pendingCount()).toBe(1);
    expect(disposedClaims).toEqual([]);
  });

  it('a stale claim cannot release a newer claim for the same owner + id', () => {
    const { registry, disposedClaims } = setup();
    const { wc } = makeCountingWc(1);
    const stale = registry.reserveClaim('c1', wc as never, { resource: 'stale' })!;
    expect(registry.cancelClaim('c1', 1)).toBe(true);
    const newer = registry.reserveClaim('c1', wc as never, { resource: 'newer' })!;

    registry.releaseClaim(stale);

    expect(registry.isClaimLive(stale)).toBe(false);
    expect(registry.isClaimLive(newer)).toBe(true);
    expect(registry.pendingCount()).toBe(1);
    expect(disposedClaims).toEqual(['stale']);
  });

  it('renderer death disposes exactly its own claims, not another window’s', () => {
    const { registry, disposedClaims } = setup();
    const a = makeCountingWc(1);
    const b = makeCountingWc(2);
    const mine = registry.reserveClaim('shared', a.wc as never, {
      abort: new AbortController(),
      resource: 'mine',
    })!;
    const mineToo = registry.reserveClaim('other', a.wc as never, { resource: 'mineToo' })!;
    const theirs = registry.reserveClaim('shared', b.wc as never, {
      abort: new AbortController(),
      resource: 'theirs',
    })!;

    a.destroy();

    expect(mine.abort?.signal.aborted).toBe(true);
    expect(registry.isClaimLive(mine)).toBe(false);
    expect(registry.isClaimLive(mineToo)).toBe(false);
    expect(disposedClaims.sort()).toEqual(['mine', 'mineToo']);
    expect(theirs.abort?.signal.aborted).toBe(false);
    expect(registry.isClaimLive(theirs)).toBe(true);
    expect(registry.pendingCount()).toBe(1);
  });

  it('a document reset on a surviving webContents also disposes its claims', () => {
    const { registry, disposedClaims } = setup();
    const a = makeCountingWc(1);
    const claim = registry.reserveClaim('c1', a.wc as never, { resource: 'mine' })!;

    a.reload();

    expect(registry.isClaimLive(claim)).toBe(false);
    expect(disposedClaims).toEqual(['mine']);
    // Still bound for the next document on the same webContents.
    const next = registry.reserveClaim('c2', a.wc as never, { resource: 'next' })!;
    a.reload();
    expect(registry.isClaimLive(next)).toBe(false);
    expect(disposedClaims).toEqual(['mine', 'next']);
  });

  it('refuses a reserve from an already-destroyed sender and disposes the claim', () => {
    const { registry, disposedClaims } = setup();
    const dead = makeCountingWc(1, { destroyed: true });

    const claim = registry.reserveClaim('c1', dead.wc as never, { resource: 'orphan' });

    expect(claim).toBeUndefined();
    expect(registry.pendingCount()).toBe(0);
    expect(disposedClaims).toEqual(['orphan']);
  });

  it.each([
    [
      'cancel',
      (r: ReturnType<typeof setup>['registry']) => {
        r.cancelClaim('c1', 1);
      },
    ],
    ['module teardown', (r: ReturnType<typeof setup>['registry']) => r.disposeAllClaims()],
  ])('%s during an awaited DNS/keychain step leaves the claim dead', async (_name, invalidate) => {
    const { registry, disposedEntries, entry } = setup();
    const { wc } = makeCountingWc(1);
    const claim = registry.reserveClaim('c1', wc as never, { abort: new AbortController() })!;

    let resolveDns!: () => void;
    const dial = (async () => {
      await new Promise<void>((resolve) => {
        resolveDns = resolve;
      });
      if (!registry.isClaimLive(claim)) return 'stale-before-transport';
      return registry.commitClaim(claim, wc as never, entry('c1', 1));
    })();

    invalidate(registry);
    resolveDns();

    expect(await dial).toBe('stale-before-transport');
    expect(claim.abort?.signal.aborted).toBe(true);
    // Even a dial that skipped the check cannot register against a dead claim.
    expect(registry.commitClaim(claim, wc as never, entry('c1', 1))).toBe(false);
    expect(registry.size()).toBe(0);
    expect(disposedEntries).toEqual([]);
  });

  it('renderer death during an awaited step blocks the commit', async () => {
    const { registry, entry } = setup();
    const a = makeCountingWc(1);
    const claim = registry.reserveClaim('c1', a.wc as never)!;

    a.destroy();
    await Promise.resolve();

    expect(registry.commitClaim(claim, a.wc as never, entry('c1', 1))).toBe(false);
    expect(registry.size()).toBe(0);
  });

  it('cancelClaim invalidates before disposing, so synchronous teardown sees it dead', () => {
    let liveDuringDispose: boolean | undefined;
    const registry: StreamRegistry<TestEntry, TestClaimFields> = new StreamRegistry({
      dispose: () => {},
      disposeClaim: (claim) => {
        liveDuringDispose = registry.isClaimLive(claim);
      },
    });
    const claim = registry.reserveClaim('c1', makeCountingWc(1).wc as never)!;

    expect(registry.cancelClaim('c1', 1)).toBe(true);
    expect(liveDuringDispose).toBe(false);
    expect(registry.isClaimLive(claim)).toBe(false);
  });

  it('cancelClaim is owner-scoped and reports a missing claim', () => {
    const { registry, disposedClaims } = setup();
    const claim = registry.reserveClaim('c1', makeCountingWc(1).wc as never, { resource: 'mine' })!;

    expect(registry.cancelClaim('c1', 2)).toBe(false);
    expect(registry.cancelClaim('missing', 1)).toBe(false);
    expect(registry.isClaimLive(claim)).toBe(true);
    expect(disposedClaims).toEqual([]);
  });

  it('commits a first connect through a live claim', () => {
    const { registry, entry } = setup();
    const { wc } = makeCountingWc(1);
    const claim = registry.reserveClaim('c1', wc as never)!;
    const e = entry('c1', 1);

    expect(claim.ownerEntry).toBeUndefined();
    expect(registry.commitClaim(claim, wc as never, e)).toBe(true);
    expect(registry.get('c1', 1)).toBe(e);
  });

  it('a first-connect claim refuses to commit over an entry that appeared meanwhile', () => {
    const { registry, disposedEntries, entry } = setup();
    const { wc } = makeCountingWc(1);
    const claim = registry.reserveClaim('c1', wc as never)!;
    const winner = entry('winner', 1);
    registry.tryAdd('c1', wc as never, winner);

    expect(registry.commitClaim(claim, wc as never, entry('late', 1))).toBe(false);
    expect(registry.get('c1', 1)).toBe(winner);
    expect(disposedEntries).toEqual([]);
  });

  it('a reconnect captures the owner entry and replaces only that entry', () => {
    const { registry, disposedEntries, entry } = setup();
    const { wc } = makeCountingWc(1);
    const original = entry('original', 1);
    registry.tryAdd('c1', wc as never, original);
    const claim = registry.reserveClaim('c1', wc as never)!;
    expect(claim.ownerEntry).toBe(original);

    const replacement = entry('replacement', 1);
    expect(registry.commitClaim(claim, wc as never, replacement)).toBe(true);
    expect(registry.get('c1', 1)).toBe(replacement);
    expect(disposedEntries).toEqual(['original']);
  });

  it('a reconnect refuses to replace an entry newer than the one it captured', () => {
    const { registry, disposedEntries, entry } = setup();
    const { wc } = makeCountingWc(1);
    registry.tryAdd('c1', wc as never, entry('original', 1));
    const claim = registry.reserveClaim('c1', wc as never)!;
    registry.remove('c1', 1);
    const newer = entry('newer', 1);
    registry.tryAdd('c1', wc as never, newer);

    expect(registry.commitClaim(claim, wc as never, entry('late', 1))).toBe(false);
    expect(registry.get('c1', 1)).toBe(newer);
    expect(disposedEntries).toEqual([]);
  });

  it('does not capture another renderer’s entry as the owner entry', () => {
    const { registry, entry } = setup();
    registry.tryAdd('shared', makeCountingWc(1).wc as never, entry('theirs', 1));

    const claim = registry.reserveClaim('shared', makeCountingWc(2).wc as never)!;

    expect(claim.ownerEntry).toBeUndefined();
  });

  it('binds one claim cleanup listener per sender however many reserves it makes', () => {
    const { registry, disposedClaims, entry } = setup();
    const a = makeCountingWc(1);
    const claim = registry.reserveClaim('c1', a.wc as never, { resource: 'c1' })!;
    expect(a.destroyedListenerCount()).toBe(1);
    registry.reserveClaim('c2', a.wc as never, { resource: 'c2' });
    registry.reserveClaim('c1', a.wc as never); // refused duplicate
    registry.releaseClaim(claim);
    registry.reserveClaim('c1', a.wc as never, { resource: 'c1-again' });
    expect(a.destroyedListenerCount()).toBe(1);

    // Live entries keep their own single listener alongside the claim one.
    registry.tryAdd('live', a.wc as never, entry('live', 1));
    registry.tryAdd('live2', a.wc as never, entry('live2', 1));
    expect(a.destroyedListenerCount()).toBe(2);

    const b = makeCountingWc(2);
    registry.reserveClaim('c1', b.wc as never);
    expect(b.destroyedListenerCount()).toBe(1);

    a.destroy();
    // Each surviving claim torn down exactly once.
    expect(disposedClaims.sort()).toEqual(['c1-again', 'c2']);
  });

  it('carries protocol fields and lets the handler mutate them before disposal', () => {
    const { registry, disposedClaims } = setup();
    const a = makeCountingWc(1);
    const claim = registry.reserveClaim('c1', a.wc as never)!;
    claim.resource = 'attached-after-reserve';

    a.destroy();

    expect(disposedClaims).toEqual(['attached-after-reserve']);
  });

  it('disposeAllClaims disposes everything; clearClaims drops without disposing', () => {
    const first = setup();
    first.registry.reserveClaim('c1', makeCountingWc(1).wc as never, { resource: 'a' });
    first.registry.reserveClaim('c1', makeCountingWc(2).wc as never, { resource: 'b' });
    first.registry.disposeAllClaims();
    expect(first.disposedClaims.sort()).toEqual(['a', 'b']);
    expect(first.registry.pendingCount()).toBe(0);

    const second = setup();
    const claim = second.registry.reserveClaim('c1', makeCountingWc(1).wc as never, {
      resource: 'a',
    })!;
    second.registry.clearClaims();
    expect(second.disposedClaims).toEqual([]);
    expect(second.registry.isClaimLive(claim)).toBe(false);
  });

  it('pendingClaims supports a sweep that evicts through releaseClaim', () => {
    const { registry, disposedClaims } = setup();
    const { wc } = makeCountingWc(1);
    const old = registry.reserveClaim('old', wc as never, { resource: 'old' })!;
    const fresh = registry.reserveClaim('fresh', wc as never, { resource: 'fresh' })!;

    for (const claim of registry.pendingClaims()) {
      if (claim.resource === 'old') registry.releaseClaim(claim);
    }

    expect(registry.isClaimLive(old)).toBe(false);
    expect(registry.isClaimLive(fresh)).toBe(true);
    expect(old.connectionId).toBe('old');
    expect(old.webContentsId).toBe(1);
    expect(disposedClaims).toEqual([]);
  });

  it('entry-level clear and disposeAll leave claims alone', () => {
    const { registry, disposedClaims } = setup();
    const claim = registry.reserveClaim('c1', makeCountingWc(1).wc as never, { resource: 'a' })!;

    registry.clear();
    registry.disposeAll();

    expect(registry.isClaimLive(claim)).toBe(true);
    expect(disposedClaims).toEqual([]);
  });

  it('a throwing disposeClaim never escapes and still invalidates the claim', () => {
    const registry = new StreamRegistry<TestEntry>({
      dispose: () => {},
      disposeClaim: () => {
        throw new Error('boom');
      },
    });
    const a = makeCountingWc(1);
    const cancelled = registry.reserveClaim('cancelled', a.wc as never)!;
    expect(() => registry.cancelClaim('cancelled', 1)).not.toThrow();
    expect(registry.isClaimLive(cancelled)).toBe(false);

    const allGone = registry.reserveClaim('all', a.wc as never)!;
    expect(() => registry.disposeAllClaims()).not.toThrow();
    expect(registry.isClaimLive(allGone)).toBe(false);

    const dead = registry.reserveClaim('dead', a.wc as never)!;
    expect(() => a.destroy()).not.toThrow();
    expect(registry.isClaimLive(dead)).toBe(false);
  });

  it('claims work with no disposeClaim configured', () => {
    const registry = new StreamRegistry<TestEntry>({ dispose: () => {} });
    const a = makeCountingWc(1);
    const claim = registry.reserveClaim('c1', a.wc as never)!;
    expect(registry.cancelClaim('c1', 1)).toBe(true);
    const next = registry.reserveClaim('c1', a.wc as never)!;
    a.destroy();
    expect(registry.isClaimLive(claim)).toBe(false);
    expect(registry.isClaimLive(next)).toBe(false);
  });
});

describe('emitToEntry', () => {
  beforeEach(() => mockEmitTo.mockClear());

  it('prefers the cached renderer while it is alive', () => {
    const live = makeCountingWc(5);
    emitToEntry({ webContentsId: 5, wc: live.wc as never }, 'chan', 1, 2);
    expect(live.wc.send).toHaveBeenCalledWith('chan', 1, 2);
    expect(mockEmitTo).not.toHaveBeenCalled();
  });

  it('falls back to id-based emission when the cache is destroyed or absent', () => {
    const dead = makeCountingWc(5, { destroyed: true });
    emitToEntry({ webContentsId: 5, wc: dead.wc as never }, 'chan', 'x');
    expect(dead.wc.send).not.toHaveBeenCalled();
    expect(mockEmitTo).toHaveBeenCalledWith(5, 'chan', 'x');

    mockEmitTo.mockClear();
    emitToEntry({ webContentsId: 6 }, 'chan');
    expect(mockEmitTo).toHaveBeenCalledWith(6, 'chan');
  });
});
