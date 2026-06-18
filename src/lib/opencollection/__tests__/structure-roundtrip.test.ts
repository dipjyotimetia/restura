/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures inspect untyped OC nodes */
import { describe, it, expect } from 'vitest';
import { parseOpenCollectionYAML, serializeOpenCollectionYAML } from '../serializer';
import { loadCollectionFromFile } from '../fs-reader';
import { ocToInternal } from '../to-internal';
import { internalToOC } from '../from-internal';
import type { Collection } from '@/types';

/**
 * Root-level structural staleness on OpenCollection re-export (GH #278).
 *
 * The `_oc` passthrough keeps unmodified collections byte-stable, and the store
 * strips the `_oc` bag of every ancestor folder on edit/add/remove/move — so any
 * NESTED change already defeats the Strategy-1 verbatim shortcut. The one gap is
 * a ROOT-level removal: the store strips nothing (no ancestor folder), every
 * surviving sibling keeps its bag, so the shortcut used to fire and re-emit the
 * deleted item. `rootStructureUnchanged` closes that gap via a root count
 * reconciliation (honoring the sse/mcp-in-`extensions` asymmetry). These tests
 * pin that, plus byte-stability for genuinely unmodified collections.
 */

type Internal = Collection & { _oc?: unknown };

/** Remove a root item by name, preserving sibling `_oc` bags — exactly what the
 *  store produces for a root removal (its ancestorPath is empty, so it strips
 *  nothing). */
function removeRootByName(internal: Internal, name: string): Internal {
  return { ...internal, items: internal.items.filter((i) => i.name !== name) };
}

function itemNames(out: any): string[] {
  return (out.items ?? []).map((i: any) => i.info?.name);
}

async function loadInternal(fixture: string): Promise<Internal> {
  const oc = await loadCollectionFromFile(`tests/fixtures/opencollection/${fixture}`);
  return ocToInternal(oc) as Internal;
}

describe('OpenCollection root-level structural staleness — removal', () => {
  it('removing a root http item does not resurrect it', async () => {
    const internal = await loadInternal('multi-protocol.yaml');
    const out: any = internalToOC(removeRootByName(internal, 'Health Check'));
    expect(itemNames(out)).not.toContain('Health Check');
    expect(out.items).toHaveLength(3); // 4 cached items minus the removed http
  });

  it('removing a root grpc item does not resurrect it', async () => {
    const internal = await loadInternal('multi-protocol.yaml');
    const out: any = internalToOC(removeRootByName(internal, 'GetUser'));
    expect(itemNames(out)).not.toContain('GetUser');
  });

  it('removing a root graphql item does not resurrect it', async () => {
    const internal = await loadInternal('multi-protocol.yaml');
    const out: any = internalToOC(removeRootByName(internal, 'List Users'));
    expect(itemNames(out)).not.toContain('List Users');
  });

  it('removing the root websocket placeholder folder does not resurrect it', async () => {
    const internal = await loadInternal('multi-protocol.yaml');
    const out: any = internalToOC(removeRootByName(internal, 'Stock Ticker (WebSocket)'));
    expect(itemNames(out)).not.toContain('Stock Ticker');
  });

  it('removing the root sse item clears x-restura-sse and keeps opaque extensions', async () => {
    const internal = await loadInternal('multi-protocol.yaml');
    const out: any = internalToOC(removeRootByName(internal, 'Server Events'));
    expect(out.extensions?.['x-restura-sse']).toBeUndefined();
    // Opaque extension with no live counterpart must survive the rebuild.
    expect(out.extensions?.['x-restura-socketio']).toBeDefined();
  });

  it('removing a root mcp item clears x-restura-mcp', () => {
    const oc = parseOpenCollectionYAML(`opencollection: 1.0.0
info:
  name: MCP Demo
items:
  - info: { type: http, name: Keep }
    http: { method: GET, url: https://example.com }
extensions:
  x-restura-mcp:
    - info: { type: mcp, name: Inspector }
      mcp: { url: http://localhost:3000, transport: streamable-http }
`);
    const internal = ocToInternal(oc) as Internal;
    const out: any = internalToOC(removeRootByName(internal, 'Inspector'));
    expect(out.extensions?.['x-restura-mcp']).toBeUndefined();
    expect(itemNames(out)).toContain('Keep');
  });
});

describe('OpenCollection root-level structural staleness — byte-stability (no false positives)', () => {
  it('unmodified multi-protocol round-trips byte-stable (socketio + websocket canary)', async () => {
    const oc = await loadCollectionFromFile('tests/fixtures/opencollection/multi-protocol.yaml');
    const out = internalToOC(ocToInternal(oc));
    expect(serializeOpenCollectionYAML(out)).toBe(serializeOpenCollectionYAML(oc));
  });

  it('unmodified simple-http round-trips byte-stable', async () => {
    const oc = await loadCollectionFromFile('tests/fixtures/opencollection/simple-http.yaml');
    const out = internalToOC(ocToInternal(oc));
    expect(serializeOpenCollectionYAML(out)).toBe(serializeOpenCollectionYAML(oc));
  });

  it('removing 1 of N leaves the surviving items byte-identical (verbatim)', async () => {
    const oc: any = await loadCollectionFromFile(
      'tests/fixtures/opencollection/multi-protocol.yaml'
    );
    const internal = ocToInternal(oc) as Internal;
    const out: any = internalToOC(removeRootByName(internal, 'GetUser'));
    // Each survivor emits from its own _oc bag — identical to the source OC item.
    const srcByName = Object.fromEntries((oc.items as any[]).map((i) => [i.info.name, i]));
    for (const name of ['Health Check', 'List Users', 'Stock Ticker']) {
      const emitted = (out.items as any[]).find((i) => i.info?.name === name);
      expect(emitted).toEqual(srcByName[name]);
    }
  });

  it('root config + opaque extensions survive the post-removal rebuild', async () => {
    const internal = await loadInternal('multi-protocol.yaml');
    const out: any = internalToOC(removeRootByName(internal, 'Health Check'));
    expect(out.config?.environments?.[0]?.name).toBe('dev');
    expect(out.info?.version).toBe('0.1.0');
    expect(out.extensions?.['x-restura-socketio']).toBeDefined();
  });
});
