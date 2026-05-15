/* eslint-disable @typescript-eslint/no-explicit-any -- TODO(maintainability): narrow these test fixture casts (Internal/Collection shapes) */
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

  it('preserves root metadata when partial edits happen (Strategy 2)', () => {
    // Simulates: a Bruno collection imported with a `config.protobuf` block,
    // a non-restura extension, and an info.version. The user edits one
    // request inside one folder. Root-level metadata must survive.
    const cachedRoot: any = {
      opencollection: '1.0.0',
      info: { name: 'API', version: '2.3.0', authors: [{ name: 'Bruno' }] },
      docs: 'Long-form docs preserved here',
      config: {
        protobuf: { protoFiles: [{ path: 'service.proto' }] },
        environments: [
          { name: 'dev', variables: [{ name: 'HOST', value: 'http://localhost:8080' }] },
        ],
      },
      extensions: {
        'x-third-party-tool': { foo: 'bar' },
        'x-restura-sse': [
          { info: { type: 'sse', name: 'Events' }, sse: { url: '/events' } },
        ],
      },
      items: [],
    };
    const internal: any = {
      id: 'c',
      name: 'API',
      _oc: cachedRoot,
      items: [
        // Modified item: no _oc bag → must be rebuilt
        {
          id: 'edited',
          type: 'request',
          name: 'Edited',
          request: {
            id: 'edited',
            name: 'Edited',
            type: 'http',
            method: 'POST',
            url: '/v2/edited',
            headers: [],
            params: [],
            body: { type: 'none' },
            auth: { type: 'none' },
          },
        },
      ],
    };
    const oc = internalToOC(internal);

    // Root metadata survives:
    expect(oc.info.version).toBe('2.3.0');
    expect((oc.info.authors as any[])[0].name).toBe('Bruno');
    expect(oc.docs).toBe('Long-form docs preserved here');
    expect((oc.config?.protobuf as any).protoFiles[0].path).toBe('service.proto');
    expect(oc.config?.environments?.[0]?.name).toBe('dev');
    expect((oc.extensions as any)['x-third-party-tool']).toEqual({ foo: 'bar' });

    // Items got rebuilt:
    expect(oc.items?.length).toBe(1);
    expect((oc.items?.[0] as any).info.name).toBe('Edited');
    expect((oc.items?.[0] as any).http.method).toBe('POST');

    // Restura-managed extensions got cleared because no SSE/MCP items remain:
    expect((oc.extensions as any)['x-restura-sse']).toBeUndefined();
  });

  it('round-trips OAuth1 / NTLM / WSSE auth via _oc even though Restura runtime ignores them', () => {
    // OpenCollection v1 supports auth methods Restura's runtime doesn't yet
    // run (OAuth1, NTLM, WSSE). The to-internal mapper degrades them to
    // {type: 'none'} but stashes the original on _oc so export round-trips
    // them verbatim — critical for not breaking Bruno collections that use
    // these methods when a user opens them in Restura.
    const cachedItem: any = {
      info: { type: 'http', name: 'Legacy SOAP' },
      http: {
        method: 'POST',
        url: 'https://legacy.example/soap',
        auth: {
          type: 'oauth1',
          consumerKey: 'ck',
          consumerSecret: 'cs',
          accessToken: 'tok',
          accessTokenSecret: 'ts',
        },
      },
    };
    const internal: any = {
      id: 'c',
      name: 'OAuth1 Demo',
      _oc: { opencollection: '1.0.0', info: { name: 'OAuth1 Demo' }, items: [cachedItem] },
      items: [
        {
          id: 'r',
          type: 'request',
          name: 'Legacy SOAP',
          _oc: cachedItem,
          // Restura's internal Request degrades the auth to 'none', but _oc carries the truth.
          request: {
            id: 'r',
            name: 'Legacy SOAP',
            type: 'http',
            method: 'POST',
            url: 'https://legacy.example/soap',
            headers: [],
            params: [],
            body: { type: 'none' },
            auth: { type: 'none' },
          },
        },
      ],
    };
    const oc = internalToOC(internal);
    // The cached _oc should win (Strategy 1 — every item has _oc), so the
    // OAuth1 auth survives intact.
    const item = oc.items?.[0] as any;
    expect(item.http.auth.type).toBe('oauth1');
    expect(item.http.auth.consumerKey).toBe('ck');
    expect(item.http.auth.accessToken).toBe('tok');
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

  it('emits scripts from preRequestScript and testScript', () => {
    const internal: any = {
      id: 'col-scripts',
      name: 'Scripts Col',
      items: [
        {
          id: 'r-scripts',
          type: 'request',
          name: 'With Scripts',
          request: {
            id: 'r-scripts',
            name: 'With Scripts',
            type: 'http',
            method: 'POST',
            url: 'https://api.example.com',
            headers: [],
            params: [],
            body: { type: 'none' },
            auth: { type: 'none' },
            preRequestScript: 'console.log("pre");',
            testScript: 'pm.test("ok", () => {});',
          },
        },
      ],
    };
    const oc = internalToOC(internal);
    const item = oc.items?.[0] as any;
    expect(item?.runtime?.scripts).toHaveLength(2);
    expect(item.runtime.scripts[0].type).toBe('before-request');
    expect(item.runtime.scripts[1].type).toBe('tests');
  });

  it('handles gRPC streaming method types in conversion', () => {
    const methodTypes = ['unary', 'server-streaming', 'client-streaming', 'bidirectional-streaming'] as const;
    for (const mt of methodTypes) {
      const internal: any = {
        id: 'col-grpc',
        name: 'gRPC Col',
        items: [
          {
            id: `r-${mt}`,
            type: 'request',
            name: mt,
            request: {
              id: `r-${mt}`,
              name: mt,
              type: 'grpc',
              methodType: mt,
              url: 'https://grpc.example.com',
              service: 'svc.v1.Service',
              method: 'Call',
              metadata: [],
              message: '{}',
              auth: { type: 'none' },
            },
          },
        ],
      };
      // Should not throw — coverage goal is to exercise all methodTypeFromInternal branches
      expect(() => internalToOC(internal)).not.toThrow();
    }
  });
});
