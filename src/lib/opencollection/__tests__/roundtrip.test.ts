import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCollectionFromFile, loadCollectionFromDir } from '../fs-reader';
import { saveCollectionToFile, saveCollectionToDir } from '../fs-writer';

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
    const socketio = oc2.extensions?.['x-restura-socketio'] as Array<{ socketio?: { namespace?: string } }>;
    expect(socketio[0]?.socketio?.namespace).toBe('/chat');
  });

  it('dir-layout: dir -> save dir -> reload', async () => {
    const oc1 = await loadCollectionFromDir('tests/fixtures/opencollection/dir-layout');
    await saveCollectionToDir(oc1, tmp);
    const oc2 = await loadCollectionFromDir(tmp);
    expect(oc2).toEqual(oc1);
  });
});
