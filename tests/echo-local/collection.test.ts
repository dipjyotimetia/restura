import { internalToOC } from '@shared/opencollection/from-internal';
import {
  parseOpenCollectionYAML,
  serializeOpenCollectionYAML,
} from '@shared/opencollection/serializer';
import { ocToInternal } from '@shared/opencollection/to-internal';
import { describe, expect, it } from 'vitest';
import { importOpenCollection } from '@/features/collections/lib/importers/opencollection';
import type { CollectionItem, McpRequest, Request } from '@/types';
import { buildCollection } from '../../echo-local/collection';
import { requestOf } from '../helpers/requestOf';

// The generated collection must import into the desktop client with ZERO
// warnings and produce runnable requests for every protocol it claims to cover.
// This guards the "import → click Send → it works" promise against schema or
// auth-mapping drift in src/lib/opencollection.

function flattenRequests(items: CollectionItem[]): Request[] {
  const out: Request[] = [];
  const walk = (list: CollectionItem[]): void => {
    for (const it of list) {
      if (it.type === 'request' && it.request) out.push(requestOf(it));
      if (it.items) walk(it.items);
    }
  };
  walk(items);
  return out;
}

describe('echo-local generated collection', () => {
  it('imports cleanly with no warnings', () => {
    const result = importOpenCollection(buildCollection());
    expect(result.warnings).toEqual([]);
  });

  it('produces runnable requests for every covered protocol', () => {
    const { collection } = importOpenCollection(buildCollection());
    const requests = flattenRequests(collection.items);
    const types = new Set(requests.map((r) => r.type));

    expect(types).toContain('http');
    expect(types).toContain('grpc');
    expect(types).toContain('sse');
    expect(types).toContain('mcp');

    // GraphQL imports as an HTTP request with a graphql body.
    const graphql = requests.find((r) => r.type === 'http' && r.body?.type === 'graphql');
    expect(graphql).toBeDefined();
  });

  it('round-trips the auth schemes it includes', () => {
    const { collection } = importOpenCollection(buildCollection());
    const authTypes = new Set(
      flattenRequests(collection.items)
        .map((r) => r.auth?.type)
        .filter(Boolean)
    );

    // These must survive OpenCollection import — they're the click-Send creds.
    expect(authTypes).toContain('basic');
    expect(authTypes).toContain('bearer');
    expect(authTypes).toContain('api-key');
    expect(authTypes).toContain('aws-signature');
  });

  it('targets the stable echo-local ports', () => {
    const oc = buildCollection() as {
      items: Array<{ http?: { url: string }; grpc?: { url: string } }>;
    };
    const grpc = oc.items.find((i) => i.grpc);
    expect(grpc?.grpc?.url).toBe('http://localhost:50051');
    const httpJson = oc.items.find((i) => i.http?.url.endsWith('/json'));
    expect(httpJson?.http?.url).toBe('http://localhost:8080/json');
  });
});

describe('echo-local MCP examples (#901)', () => {
  const mcpRequests = (items: CollectionItem[]) =>
    flattenRequests(items).filter((r): r is McpRequest => r.type === 'mcp');

  it('import as runnable operations carrying method, params and a test script', () => {
    const { collection } = importOpenCollection(buildCollection());
    const mcp = mcpRequests(collection.items);
    expect(mcp.length).toBeGreaterThanOrEqual(3);
    for (const r of mcp) {
      expect(r.defaultMethod).toBeTruthy();
      expect(() => JSON.parse(r.defaultParams ?? '')).not.toThrow();
      expect(r.testScript).toMatch(/rs\.test\(/);
    }
    expect(mcp.some((r) => r.testScript?.includes('isError'))).toBe(true);
    expect(mcp.some((r) => r.testScript?.includes('error.code'))).toBe(true);
  });

  it('method + params round-trip through OpenCollection, including after an edit', () => {
    const { collection } = importOpenCollection(buildCollection());
    const before = mcpRequests(collection.items);
    const reimported = ocToInternal(
      parseOpenCollectionYAML(serializeOpenCollectionYAML(internalToOC(collection)))
    );
    expect(
      mcpRequests(reimported.items).map((r) => [r.name, r.defaultMethod, r.defaultParams])
    ).toEqual(before.map((r) => [r.name, r.defaultMethod, r.defaultParams]));

    // An in-app edit drops the cached `_oc` entry; the export must carry the new operation.
    const item = collection.items.find((i) => i.request?.type === 'mcp') as
      | (CollectionItem & { _oc?: unknown })
      | undefined;
    if (!item?.request) throw new Error('no MCP item');
    item.request = {
      ...(item.request as McpRequest),
      defaultMethod: 'prompts/get',
      defaultParams: '{"name":"greet","arguments":{"name":"Ada"}}',
    };
    delete item._oc;
    const edited = mcpRequests(
      ocToInternal(parseOpenCollectionYAML(serializeOpenCollectionYAML(internalToOC(collection))))
        .items
    ).find((r) => r.name === item.name);
    expect(edited).toMatchObject({
      defaultMethod: 'prompts/get',
      defaultParams: '{"name":"greet","arguments":{"name":"Ada"}}',
    });
  });
});
