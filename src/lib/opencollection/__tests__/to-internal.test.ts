import { describe, expect, it } from 'vitest';
import { internalToOC } from '../from-internal';
import { loadCollectionFromFile } from '../fs-reader';
import { ocToInternal } from '../to-internal';

describe('request description round-trip', () => {
  it('preserves an HTTP request description through export → import', () => {
    const internal = {
      id: 'c',
      name: 'C',
      items: [
        {
          id: 'r',
          name: 'R',
          type: 'request',
          request: {
            id: 'r',
            name: 'R',
            type: 'http',
            method: 'GET',
            url: 'https://api.example/y',
            headers: [],
            params: [],
            body: { type: 'none' },
            auth: { type: 'none' },
            description: 'AI-enriched docs survive the round-trip.',
          },
        },
      ],
    } as never;
    const back = ocToInternal(internalToOC(internal));
    // biome-ignore lint/suspicious/noExplicitAny: discriminated union test access
    expect((back.items[0]?.request as any).description).toBe(
      'AI-enriched docs survive the round-trip.'
    );
  });
});

describe('ocToInternal', () => {
  it('maps a single HTTP request', async () => {
    const oc = await loadCollectionFromFile('tests/fixtures/opencollection/simple-http.yaml');
    const collection = ocToInternal(oc);
    expect(collection.name).toBe('Simple HTTP Demo');
    expect(collection.items.length).toBe(1);
    const item = collection.items[0]!;
    expect(item.type).toBe('request');
    expect(item.request?.type).toBe('http');
    // biome-ignore lint/suspicious/noExplicitAny: TODO(maintainability): narrow this discriminated-union access to HttpRequest
    expect((item.request as any).method).toBe('GET');
  });

  it('maps multi-protocol fixture: http, graphql (as http), grpc, websocket (as folder), and SSE via extensions', async () => {
    const oc = await loadCollectionFromFile('tests/fixtures/opencollection/multi-protocol.yaml');
    const collection = ocToInternal(oc);
    const types = collection.items.map((i) => i.request?.type ?? `folder:${i.name}`);
    // Expect the HTTP item, the GraphQL-as-HTTP item, the gRPC, the WebSocket-as-folder, and the SSE-from-extensions
    expect(types).toContain('http');
    expect(types).toContain('grpc');
    expect(types).toContain('sse'); // from extensions['x-restura-sse']
    // GraphQL was mapped to HttpRequest, so 2 'http' entries are valid
    const httpCount = types.filter((t) => t === 'http').length;
    expect(httpCount).toBeGreaterThanOrEqual(2);
    // WebSocket placeholder folder
    const wsItems = collection.items.filter(
      (i) => i.type === 'folder' && /websocket/i.test(i.name)
    );
    expect(wsItems.length).toBe(1);
  });

  it('preserves OpenCollection passthrough on each item via _oc bag', async () => {
    const oc = await loadCollectionFromFile('tests/fixtures/opencollection/simple-http.yaml');
    const collection = ocToInternal(oc);
    // biome-ignore lint/suspicious/noExplicitAny: TODO(maintainability): narrow this _oc passthrough access (untyped extension bag)
    expect((collection.items[0] as any)._oc).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: TODO(maintainability): narrow this _oc passthrough access (untyped extension bag)
    expect((collection as any)._oc).toBeDefined();
  });

  it('extracts root variables from first environment', async () => {
    const oc = await loadCollectionFromFile('tests/fixtures/opencollection/multi-protocol.yaml');
    const collection = ocToInternal(oc);
    expect(collection.variables?.length).toBe(1);
    expect(collection.variables?.[0]?.key).toBe('API_HOST');
  });
});
