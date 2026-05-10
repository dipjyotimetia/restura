import { describe, it, expect } from 'vitest';
import { loadCollectionFromFile } from '../fs-reader';
import { ocToInternal } from '../to-internal';
import { internalToOC } from '../from-internal';

describe('internalToOC', () => {
  it('roundtrips simple-http via internal model (cached _oc path)', async () => {
    const oc = await loadCollectionFromFile('tests/fixtures/opencollection/simple-http.yaml');
    const internal = ocToInternal(oc);
    const oc2 = internalToOC(internal);
    expect(oc2).toEqual(oc);
  });

  it('roundtrips multi-protocol with SSE in extensions (cached path)', async () => {
    const oc = await loadCollectionFromFile('tests/fixtures/opencollection/multi-protocol.yaml');
    const internal = ocToInternal(oc);
    const oc2 = internalToOC(internal);
    expect(oc2).toEqual(oc);
  });

  it('emits a fresh OC for an internal Collection without _oc passthrough', () => {
    const internal: any = {
      id: 'x',
      name: 'Fresh',
      items: [
        {
          id: 'r',
          type: 'request',
          name: 'Hello',
          request: {
            id: 'r',
            name: 'Hello',
            type: 'http',
            method: 'GET',
            url: 'https://example.com',
            headers: [],
            params: [],
            body: { type: 'none' },
            auth: { type: 'none' },
          },
        },
      ],
    };
    const oc = internalToOC(internal);
    expect(oc.opencollection).toBe('1.0.0');
    expect(oc.info.name).toBe('Fresh');
    expect(oc.items?.length).toBe(1);
    const item = oc.items?.[0] as any;
    expect(item.info.type).toBe('http');
    expect(item.info.name).toBe('Hello');
    expect(item.http.method).toBe('GET');
    expect(item.http.url).toBe('https://example.com');
  });

  it('rebuilds from internal when one item has been modified (no _oc on that item)', () => {
    const internal: any = {
      id: 'c',
      name: 'Mixed',
      items: [
        // unmodified: has _oc
        {
          id: 'a',
          type: 'request',
          name: 'A',
          _oc: { info: { type: 'http', name: 'A' }, http: { method: 'GET', url: 'https://a.example' } },
          request: {
            id: 'a', name: 'A', type: 'http', method: 'GET', url: 'https://a.example',
            headers: [], params: [], body: { type: 'none' }, auth: { type: 'none' },
          },
        },
        // modified: no _oc, must be rebuilt
        {
          id: 'b',
          type: 'request',
          name: 'B',
          request: {
            id: 'b', name: 'B', type: 'http', method: 'POST', url: 'https://b.example',
            headers: [], params: [], body: { type: 'json', raw: '{}' }, auth: { type: 'none' },
          },
        },
      ],
    };
    const oc = internalToOC(internal);
    expect(oc.items?.length).toBe(2);
    const b = oc.items?.[1] as any;
    expect(b.http.method).toBe('POST');
    expect(b.http.body).toBeDefined();
  });

  it('emits SSE items into extensions["x-restura-sse"] when collection has SSE requests', () => {
    const internal: any = {
      id: 'c',
      name: 'SSE Demo',
      items: [
        {
          id: 'r',
          type: 'request',
          name: 'Events',
          request: {
            id: 'r', name: 'Events', type: 'sse', url: 'https://x/events',
            headers: [], params: [], auth: { type: 'none' }, eventFilter: ['a', 'b'],
          },
        },
      ],
    };
    const oc = internalToOC(internal);
    expect(oc.items?.length).toBe(0);
    expect((oc.extensions?.['x-restura-sse'] as any[]).length).toBe(1);
    const ext = (oc.extensions?.['x-restura-sse'] as any[])[0];
    expect(ext.info.type).toBe('sse');
    expect(ext.sse.url).toBe('https://x/events');
  });
});
