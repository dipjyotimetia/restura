/* biome-ignore-all lint/suspicious/noExplicitAny: TODO(maintainability): narrow these test fixture casts (Internal/Collection shapes) */
import { describe, expect, it } from 'vitest';
import { internalToOC } from '../from-internal';
import { loadCollectionFromFile } from '../fs-reader';
import { ocToInternal } from '../to-internal';

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
          _oc: {
            info: { type: 'http', name: 'A' },
            http: { method: 'GET', url: 'https://a.example' },
          },
          request: {
            id: 'a',
            name: 'A',
            type: 'http',
            method: 'GET',
            url: 'https://a.example',
            headers: [],
            params: [],
            body: { type: 'none' },
            auth: { type: 'none' },
          },
        },
        // modified: no _oc, must be rebuilt
        {
          id: 'b',
          type: 'request',
          name: 'B',
          request: {
            id: 'b',
            name: 'B',
            type: 'http',
            method: 'POST',
            url: 'https://b.example',
            headers: [],
            params: [],
            body: { type: 'json', raw: '{}' },
            auth: { type: 'none' },
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
        'x-restura-sse': [{ info: { type: 'sse', name: 'Events' }, sse: { url: '/events' } }],
      },
      items: [],
    };
    const internal: any = {
      id: 'c',
      name: 'API',
      description: 'Long-form docs preserved here',
      variables: [{ id: 'host', key: 'HOST', value: 'http://localhost:8080', enabled: true }],
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

  it('exports every modeled body, auth, secret, and stream branch', () => {
    const bodyVariants: any[] = [
      { type: 'json' },
      { type: 'xml', raw: '<ok />' },
      { type: 'text', raw: 'hello' },
      { type: 'graphql', raw: '{ ping }' },
      { type: 'form-data' },
      { type: 'x-www-form-urlencoded', formData: [] },
      { type: 'binary' },
      {
        type: 'binary',
        binary: new File(['x'], 'payload.bin', { type: 'application/octet-stream' }),
      },
    ];
    const authVariants: any[] = [
      { type: 'none' },
      { type: 'basic', basic: { username: 'u', password: 'p' } },
      { type: 'bearer', bearer: { token: { kind: 'inline', value: 'token' } } },
      {
        type: 'api-key',
        apiKey: { key: 'x-key', value: { kind: 'handle', id: 'h1' }, in: 'query' },
      },
      {
        type: 'aws-signature',
        awsSignature: {
          accessKey: 'ak',
          secretKey: { kind: 'handle', id: 'h2', label: 'aws' },
          region: 'us-east-1',
          service: 'execute-api',
        },
      },
      { type: 'digest', digest: { username: 'du', password: 'dp' } },
      {
        type: 'oauth2',
        oauth2: { accessToken: 'access', refreshToken: undefined, tokenUrl: '/token' },
      },
    ];

    bodyVariants.forEach((body, index) => {
      const exported: any = internalToOC({
        id: `c-body-${index}`,
        name: 'Bodies',
        items: [
          {
            id: `i-${index}`,
            name: `Body ${index}`,
            type: 'request',
            request: {
              id: `r-${index}`,
              name: `Body ${index}`,
              type: 'http',
              method: 'POST',
              url: '/body',
              headers: [
                { id: 'h', key: 'x-off', value: '1', enabled: false, description: 'disabled' },
              ],
              params: [],
              body,
              auth: authVariants[index % authVariants.length],
              description: 'request docs',
              preRequestScript: 'console.log(1)',
              testScript: 'rs.test("ok", () => true)',
            },
          },
        ],
      });
      expect(exported.items).toHaveLength(1);
    });

    authVariants.forEach((auth, index) => {
      const exported: any = internalToOC({
        id: `c-auth-${index}`,
        name: 'Auth',
        variables: [
          { id: 'secret', key: 'TOKEN', value: '', enabled: false, secret: true },
          { id: 'plain', key: 'HOST', value: 'localhost', enabled: true, description: 'host' },
        ],
        auth,
        items: [],
      });
      expect(exported.info.name).toBe('Auth');
    });

    const streams: any = internalToOC({
      id: 'streams',
      name: 'Streams',
      items: [
        {
          id: 'folder',
          name: 'Folder',
          type: 'folder',
          items: [
            { id: 'opaque', name: 'Opaque', type: 'request' },
            {
              id: 'sse',
              name: 'Events',
              type: 'request',
              request: {
                id: 'sse-r',
                name: 'Events',
                type: 'sse',
                url: '/events',
                headers: [{ id: 'h', key: 'accept', value: 'text/event-stream', enabled: true }],
                params: [],
                eventFilter: ['message'],
                auth: { type: 'bearer', bearer: { token: 't' } },
              },
            },
            {
              id: 'mcp',
              name: 'MCP',
              type: 'request',
              request: {
                id: 'mcp-r',
                name: 'MCP',
                type: 'mcp',
                url: '/mcp',
                transport: 'streamable-http',
                headers: [],
                auth: { type: 'none' },
              },
            },
          ],
        },
      ],
    });
    expect(streams.extensions['x-restura-sse']).toHaveLength(1);
    expect(streams.extensions['x-restura-mcp']).toHaveLength(1);
  });

  it('handles sparse/default export shapes without inventing values', () => {
    expect(
      internalToOC({ id: 'no-items', name: 'No items', items: undefined } as any).items
    ).toEqual([]);
    const sparseBodies = [
      { type: 'xml' },
      { type: 'text' },
      { type: 'graphql' },
      { type: 'x-www-form-urlencoded' },
      { type: 'binary', binary: { name: 'portable.bin' } },
      { type: 'unsupported' },
    ];
    for (const [index, body] of sparseBodies.entries()) {
      internalToOC({
        id: `sparse-body-${index}`,
        name: 'Sparse',
        items: [
          {
            id: `i-${index}`,
            name: 'Sparse request',
            type: 'request',
            request: {
              id: `r-${index}`,
              name: 'Sparse request',
              type: 'http',
              method: 'POST',
              url: '/sparse',
              headers: [],
              params: [],
              body,
              auth: { type: 'none' },
            },
          },
        ],
      } as any);
    }

    const sparseAuth = [
      { type: 'basic', basic: {} },
      { type: 'api-key', apiKey: {} },
      { type: 'aws-signature', awsSignature: {} },
      { type: 'digest', digest: {} },
      { type: 'oauth2' },
      { type: 'unsupported' },
    ];
    for (const [index, auth] of sparseAuth.entries()) {
      internalToOC({
        id: `sparse-auth-${index}`,
        name: 'Sparse auth',
        auth,
        items: [],
      } as any);
    }

    const exported: any = internalToOC({
      id: 'mixed',
      name: 'Mixed',
      contractSpec: { source: 'inline', inline: '{}' },
      items: [
        { id: 'empty', name: 'Empty', type: 'request' },
        {
          id: 'grpc-item',
          name: 'gRPC',
          type: 'request',
          request: {
            id: 'grpc',
            name: 'gRPC',
            type: 'grpc',
            url: 'grpc://localhost',
            service: 'Demo',
            method: 'Ping',
            methodType: 'unary',
            message: '',
            metadata: [],
            auth: { type: 'basic', basic: { username: 'u', password: 'p' } },
          },
        },
        {
          id: 'mcp-item',
          name: 'MCP',
          type: 'request',
          request: {
            id: 'mcp',
            name: 'MCP',
            type: 'mcp',
            url: '/mcp',
            transport: 'streamable-http',
            headers: [{ id: 'h', key: 'x', value: '1', enabled: true }],
            auth: { type: 'bearer', bearer: { token: 't' } },
          },
        },
        {
          id: 'outer',
          name: 'Outer',
          type: 'folder',
          items: [{ id: 'inner', name: 'Inner', type: 'folder' }],
        },
      ],
    } as any);
    expect(exported.extensions['x-restura-contract']).toBeDefined();
    expect(exported.extensions['x-restura-mcp']).toHaveLength(1);
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
            id: 'r',
            name: 'Events',
            type: 'sse',
            url: 'https://x/events',
            headers: [],
            params: [],
            auth: { type: 'none' },
            eventFilter: ['a', 'b'],
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
    const methodTypes = [
      'unary',
      'server-streaming',
      'client-streaming',
      'bidirectional-streaming',
    ] as const;
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
