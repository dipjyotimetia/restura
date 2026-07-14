import { describe, expect, it } from 'vitest';
import { importOpenCollection } from '@/features/collections/lib/importers/opencollection';
import type { CollectionItem, Request } from '@/types';
import { buildCollection } from '../../echo-local/collection';

// The generated collection must import into the desktop client with ZERO
// warnings and produce runnable requests for every protocol it claims to cover.
// This guards the "import → click Send → it works" promise against schema or
// auth-mapping drift in src/lib/opencollection.

function flattenRequests(items: CollectionItem[]): Request[] {
  const out: Request[] = [];
  const walk = (list: CollectionItem[]): void => {
    for (const it of list) {
      if (it.type === 'request' && it.request) out.push(it.request);
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
