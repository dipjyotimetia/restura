import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCollectionFromDir, loadCollectionFromFile } from '../fs-reader';
import { saveCollectionToDir, saveCollectionToFile } from '../fs-writer';

describe('OpenCollection roundtrip', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'oc-rt-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('simple-http.yaml: file -> save -> reload', async () => {
    const oc1 = await loadCollectionFromFile('tests/fixtures/opencollection/simple-http.yaml');
    const dest = join(tmp, 'simple.yaml');
    await saveCollectionToFile(oc1, dest);
    const oc2 = await loadCollectionFromFile(dest);
    expect(oc2).toEqual(oc1);
  });

  it('multi-protocol.yaml: file -> save -> reload preserves x-restura-sse and x-restura-socketio', async () => {
    const oc1 = await loadCollectionFromFile('tests/fixtures/opencollection/multi-protocol.yaml');
    const dest = join(tmp, 'mp.yaml');
    await saveCollectionToFile(oc1, dest);
    const oc2 = await loadCollectionFromFile(dest);
    expect(oc2).toEqual(oc1);
    expect(oc2.extensions?.['x-restura-sse']).toBeDefined();
    // Socket.IO connections survive as opaque pass-through extensions —
    // no Request shape, no item construction, just byte-stable round-trip.
    expect(oc2.extensions?.['x-restura-socketio']).toBeDefined();
    const socketio = oc2.extensions?.['x-restura-socketio'] as Array<{
      socketio?: { namespace?: string };
    }>;
    expect(socketio[0]?.socketio?.namespace).toBe('/chat');
  });

  it('dir-layout: dir -> save dir -> reload', async () => {
    const oc1 = await loadCollectionFromDir('tests/fixtures/opencollection/dir-layout');
    const first = await saveCollectionToDir(oc1, tmp);
    const oc2 = await loadCollectionFromDir(tmp);
    // The writer stamps each item's sibling position as `info.seq`; nothing
    // else changes, and a second save is a fixed point.
    expect(oc2).toEqual(withStampedSeq(oc1));
    await saveCollectionToDir(oc2, tmp, { previousManagedFiles: first.managedFiles });
    expect(await loadCollectionFromDir(tmp)).toEqual(oc2);
  });
});

/** Copy of `oc` with every item's `info.seq` set to its 1-based sibling position. */
function withStampedSeq<T>(oc: T): T {
  const stamp = (items: unknown): unknown =>
    Array.isArray(items)
      ? items.map((it, index) => {
          const node = it as { info: object; items?: unknown };
          return {
            ...node,
            info: { ...node.info, seq: index + 1 },
            ...(node.items ? { items: stamp(node.items) } : {}),
          };
        })
      : items;
  const root = oc as { items?: unknown };
  return { ...root, items: stamp(root.items) } as T;
}
