import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEmitTo = vi.hoisted(() => vi.fn());
// Mock ipc-utils so the registry's emit is observable AND so its real `electron`
// import never loads. connection-cleanup is left REAL (it imports no electron at
// runtime), so these tests exercise the actual bindRendererCleanup/disposeByOwner
// wiring against a fake WebContents.
vi.mock('../ipc/ipc-utils', () => ({ emitTo: mockEmitTo }));

import { type StreamEntryBase, StreamRegistry } from '../ipc/stream-registry';

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
