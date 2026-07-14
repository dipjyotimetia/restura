import { describe, expect, it } from 'vitest';
import type {
  Collection,
  CollectionItem,
  GrpcRequest,
  HttpRequest,
  KeyValue,
  McpRequest,
  Request,
  SseRequest,
} from '@/types';
import { internalToOC } from '../from-internal';
import { parseOpenCollectionYAML, serializeOpenCollectionYAML } from '../serializer';
import { ocToInternal } from '../to-internal';

/**
 * Regression tests for the OpenCollection export/import audit (2026-06-16).
 * Each test pins a confirmed gap so it can't silently come back.
 */

let seq = 0;
const id = () => `id-${seq++}`;

function kv(key: string, value: string, opts: Partial<KeyValue> = {}): KeyValue {
  return { id: id(), key, value, enabled: true, ...opts };
}

function baseCollection(items: CollectionItem[], extra: Partial<Collection> = {}): Collection {
  return { id: id(), name: 'C', items, ...extra };
}

function httpReq(opts: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id: id(),
    name: 'H',
    type: 'http',
    method: 'GET',
    url: 'https://api.example.com/x',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...opts,
  };
}

function grpcReq(opts: Partial<GrpcRequest> = {}): GrpcRequest {
  return {
    id: id(),
    name: 'G',
    type: 'grpc',
    methodType: 'unary',
    url: 'grpc.example.com:443',
    service: 'pkg.Svc',
    method: 'DoThing',
    metadata: [],
    message: '{}',
    auth: { type: 'none' },
    ...opts,
  };
}

function sseReq(opts: Partial<SseRequest> = {}): SseRequest {
  return {
    id: id(),
    name: 'S',
    type: 'sse',
    url: 'https://api.example.com/events',
    headers: [],
    params: [],
    auth: { type: 'none' },
    ...opts,
  };
}

function mcpReq(opts: Partial<McpRequest> = {}): McpRequest {
  return {
    id: id(),
    name: 'M',
    type: 'mcp',
    url: 'https://api.example.com/mcp',
    transport: 'streamable-http',
    headers: [],
    auth: { type: 'none' },
    ...opts,
  };
}

function reqItem(request: Request): CollectionItem {
  return { id: id(), type: 'request', name: request.name, request };
}

function folder(name: string, items: CollectionItem[]): CollectionItem {
  return { id: id(), type: 'folder', name, items };
}

function roundtrip(c: Collection): Collection {
  const oc = internalToOC(c as Collection & { _oc?: unknown });
  const yaml = serializeOpenCollectionYAML({ ...oc, bundled: true });
  return ocToInternal(parseOpenCollectionYAML(yaml));
}

function flattenRequests(items: CollectionItem[]): Request[] {
  const out: Request[] = [];
  for (const it of items) {
    if (it.type === 'folder') out.push(...flattenRequests(it.items ?? []));
    else if (it.request) out.push(it.request);
  }
  return out;
}

describe('Fix 1 — gRPC scripts and metadata survive roundtrip', () => {
  it('preserves gRPC pre-request and test scripts', () => {
    const c = baseCollection([
      reqItem(grpcReq({ preRequestScript: 'rs.pre();', testScript: 'rs.test();' })),
    ]);
    const back = roundtrip(c);
    const g = back.items[0]!.request as GrpcRequest;
    expect(g.preRequestScript).toBe('rs.pre();');
    expect(g.testScript).toBe('rs.test();');
  });

  it('preserves gRPC metadata description', () => {
    const c = baseCollection([
      reqItem(grpcReq({ metadata: [kv('x-token', 'abc', { description: 'the token' })] })),
    ]);
    const back = roundtrip(c);
    const g = back.items[0]!.request as GrpcRequest;
    expect(g.metadata[0]?.description).toBe('the token');
  });
});

describe('Fix 2 — disabled headers/params/metadata/variables survive roundtrip', () => {
  it('preserves a disabled HTTP header', () => {
    const c = baseCollection([
      reqItem(httpReq({ headers: [kv('X-On', '1'), kv('X-Off', '2', { enabled: false })] })),
    ]);
    const back = roundtrip(c);
    const h = back.items[0]!.request as HttpRequest;
    expect(h.headers.find((x) => x.key === 'X-Off')?.enabled).toBe(false);
    expect(h.headers.find((x) => x.key === 'X-On')?.enabled).toBe(true);
  });

  it('preserves a disabled HTTP query param', () => {
    const c = baseCollection([
      reqItem(httpReq({ params: [kv('p1', 'a'), kv('p2', 'b', { enabled: false })] })),
    ]);
    const back = roundtrip(c);
    const h = back.items[0]!.request as HttpRequest;
    expect(h.params.find((x) => x.key === 'p2')?.enabled).toBe(false);
  });

  it('preserves a disabled collection variable', () => {
    const c = baseCollection([reqItem(httpReq())], {
      variables: [kv('A', '1'), kv('B', '2', { enabled: false })],
    });
    const back = roundtrip(c);
    expect(back.variables?.find((v) => v.key === 'B')?.enabled).toBe(false);
  });
});

describe('Fix 3 — binary body never crashes the exporter', () => {
  it('exports a binary HTTP body without throwing and yields serializable YAML', () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'data.bin', {
      type: 'application/octet-stream',
    });
    const c = baseCollection([reqItem(httpReq({ body: { type: 'binary', binary: file } }))]);
    expect(() => {
      const oc = internalToOC(c as Collection & { _oc?: unknown });
      serializeOpenCollectionYAML({ ...oc, bundled: true });
    }).not.toThrow();
  });
});

describe('Fix 4 — folder-nested SSE/MCP never crashes the exporter', () => {
  it('exports a folder-nested SSE request without throwing; it survives the roundtrip', () => {
    const c = baseCollection([folder('F', [reqItem(sseReq({ name: 'MySSE' }))])]);
    expect(() => internalToOC(c as Collection & { _oc?: unknown })).not.toThrow();
    const back = roundtrip(c);
    const reqs = flattenRequests(back.items);
    expect(reqs.some((r) => r.type === 'sse' && r.name === 'MySSE')).toBe(true);
  });

  it('exports a folder-nested MCP request without throwing; it survives the roundtrip', () => {
    const c = baseCollection([folder('F', [reqItem(mcpReq({ name: 'MyMCP' }))])]);
    expect(() => internalToOC(c as Collection & { _oc?: unknown })).not.toThrow();
    const back = roundtrip(c);
    const reqs = flattenRequests(back.items);
    expect(reqs.some((r) => r.type === 'mcp' && r.name === 'MyMCP')).toBe(true);
  });
});

describe('Fix 6 — secret-flagged variables never leak their value on export', () => {
  it('internalToOC emits a secret variable without its value', () => {
    const c = baseCollection([reqItem(httpReq())], {
      variables: [kv('API_KEY', 'sk-secret-123', { secret: true })],
    });
    const oc = internalToOC(c as Collection & { _oc?: unknown });
    const yaml = serializeOpenCollectionYAML({ ...oc, bundled: true });
    expect(yaml).not.toContain('sk-secret-123');
    expect(yaml).toContain('API_KEY');
  });

  it('a secret variable round-trips as a value-less secret (not dropped)', () => {
    const c = baseCollection([reqItem(httpReq())], {
      variables: [kv('API_KEY', 'sk-secret-123', { secret: true })],
    });
    const back = roundtrip(c);
    const v = back.variables?.find((x) => x.key === 'API_KEY');
    expect(v).toBeDefined();
    expect(v?.secret).toBe(true);
    expect(v?.value).toBe('');
  });

  it('a non-secret variable still exports its value (base URLs etc. are shareable)', () => {
    const c = baseCollection([reqItem(httpReq())], {
      variables: [kv('BASE_URL', 'https://api.example.com')],
    });
    const oc = internalToOC(c as Collection & { _oc?: unknown });
    const yaml = serializeOpenCollectionYAML({ ...oc, bundled: true });
    expect(yaml).toContain('https://api.example.com');
  });
});

describe('Characterization — keychain handle secrets export as opaque placeholders', () => {
  it('a handle bearer token exports as {{handle:label}}, never the keychain id', () => {
    const c = baseCollection([
      reqItem(
        httpReq({
          auth: {
            type: 'bearer',
            bearer: { token: { kind: 'handle', id: 'h-123', label: 'prod' } },
          },
        })
      ),
    ]);
    const oc = internalToOC(c as Collection & { _oc?: unknown });
    const yaml = serializeOpenCollectionYAML({ ...oc, bundled: true });
    expect(yaml).toContain('{{handle:prod}}');
    expect(yaml).not.toContain('h-123');
  });
});
