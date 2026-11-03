import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Collection run through the REAL protocol registry, request executor and
 * script sandbox. Only the network hop (`executeProxiedRequest`, the Worker /
 * IPC transport) is replaced by an in-memory server, so dispatch, GraphQL wire
 * shaping, auth inheritance, folder variables, scripts and the verdict all run
 * the production code. The sibling `collectionRunner*.test.ts` suites mock the
 * registry itself and cannot see a wrong dispatch.
 */

interface SentSpec {
  method: string;
  url: string;
  headers: Record<string, string>;
  params?: Record<string, string>;
  bodyType?: string;
  data?: string;
}

const sent: SentSpec[] = [];
type Handler = (spec: SentSpec) => { status: number; body: unknown } | Error;
let handler: Handler = () => ({ status: 200, body: {} });

vi.mock('@/lib/shared/platform', async (orig) => ({
  ...(await orig<typeof import('@/lib/shared/platform')>()),
  isElectron: () => false,
}));

vi.mock('@/lib/shared/transport', async (orig) => {
  const actual = await orig<typeof import('@/lib/shared/transport')>();
  return {
    ...actual,
    executeProxiedRequest: vi.fn(async (spec: SentSpec) => {
      sent.push(spec);
      const out = handler(spec);
      if (out instanceof Error) throw out;
      const data = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
      return {
        status: out.status,
        statusText: out.status === 200 ? 'OK' : 'ERR',
        headers: { 'content-type': 'application/json' },
        data,
        size: data.length,
      };
    }),
  };
});

import '@/features/registry/bootstrap';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { Collection, CollectionItem, HttpRequest } from '@/types';
import { runCollection } from '../collectionRunner';
import { flattenRunnables } from '../flattenRunnables';

function http(id: string, name: string, over: Partial<HttpRequest> = {}): CollectionItem {
  const request: HttpRequest = {
    id,
    name,
    type: 'http',
    method: 'GET',
    url: 'https://api.test/x',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...over,
  };
  return { id, name, type: 'request', request };
}

function folder(
  id: string,
  name: string,
  items: CollectionItem[],
  over: Partial<CollectionItem> = {}
): CollectionItem {
  return { id, name, type: 'folder', items, ...over };
}

async function run(
  collection: Collection,
  opts: { dataRows?: Record<string, string>[]; folderId?: string; stopOnFailure?: boolean } = {}
) {
  useCollectionStore.setState({ collections: [collection], activeCollectionId: null });
  const runnables = flattenRunnables(
    collection.items,
    opts.folderId,
    { preRequestScript: collection.preRequestScript, testScript: collection.testScript },
    collection.auth,
    collection
  );
  return runCollection(
    {
      collection,
      scopeName: collection.name,
      runnables,
      baseVars: { baseUrl: 'https://api.test' },
      iterations: 1,
      dataRows: opts.dataRows ?? [],
      delayMs: 0,
      stopOnFailure: opts.stopOnFailure ?? false,
    },
    () => {},
    new AbortController().signal
  );
}

beforeEach(() => {
  sent.length = 0;
  handler = () => ({ status: 200, body: {} });
});

describe('collection run over the real registry (wire-level)', () => {
  it('sends a saved GraphQL request as a GraphQL envelope, not the raw query text', async () => {
    handler = () => ({ status: 200, body: { data: { hello: 'world' } } });
    const collection: Collection = {
      id: 'c-gql',
      name: 'GQL',
      items: [
        http('g1', 'Hello', {
          method: 'POST',
          url: '{{baseUrl}}/graphql',
          body: {
            type: 'graphql',
            raw: 'query Hello($n: Int) { hello(n: $n) }',
            graphqlVariables: '{"n": 2}',
          },
        }),
      ],
    };
    const result = await run(collection);
    expect(result.requests[0]?.status).toBe('success');
    const body = JSON.parse(sent[0]?.data ?? 'null') as { query?: string; variables?: unknown };
    expect(body.query).toBe('query Hello($n: Int) { hello(n: $n) }');
    expect(body.variables).toEqual({ n: 2 });
  });

  it('gives a GraphQL item the run context: pm.collectionVariables, pm.iterationData, pm.info', async () => {
    handler = () => ({ status: 200, body: { data: { ok: true } } });
    const collection: Collection = {
      id: 'c-gql-ctx',
      name: 'GQL ctx',
      variables: [{ id: 'v-tenant', key: 'tenant', value: 'acme', enabled: true }],
      items: [
        http('g1', 'Ctx', {
          method: 'POST',
          url: '{{baseUrl}}/graphql',
          body: { type: 'graphql', raw: '{ ok }' },
          testScript: [
            "pm.test('collection var', () => pm.expect(pm.collectionVariables.get('tenant')).to.equal('acme'));",
            "pm.test('row', () => pm.expect(pm.iterationData.get('user')).to.equal('u1'));",
            "pm.test('iteration', () => pm.expect(pm.info.iteration).to.equal(0));",
          ].join('\n'),
        }),
      ],
    };
    const result = await run(collection, { dataRows: [{ user: 'u1' }] });
    const failed = result.requests[0]?.assertions.filter((a) => !a.passed) ?? [];
    expect(failed).toEqual([]);
    expect(result.requests[0]?.status).toBe('success');
  });

  it('never passes a request whose transport failed, even when every assertion passed (CLI parity)', async () => {
    handler = () => new Error('connect ECONNREFUSED 127.0.0.1:1');
    const collection: Collection = {
      id: 'c-net',
      name: 'Net',
      // A response-independent collection-level check, common in real suites.
      testScript:
        "pm.test('fast enough', () => pm.expect(pm.response.responseTime).to.be.below(60000));",
      items: [http('h1', 'Down', { url: '{{baseUrl}}/down' })],
    };
    const result = await run(collection);
    expect(result.requests[0]?.status).toBe('failed');
    expect(result.summary.failed).toBe(1);
  });

  it('chains a token across HTTP → GraphQL with nested folder auth, vars and scripts', async () => {
    handler = (spec) => {
      if (spec.url.endsWith('/login')) return { status: 200, body: { token: 'T-123' } };
      if (spec.url.endsWith('/graphql')) {
        return spec.headers.Authorization === 'Bearer T-123'
          ? { status: 200, body: { data: { me: { id: 'u1' } } } }
          : { status: 401, body: { errors: [{ message: 'unauthorized' }] } };
      }
      if (spec.url.includes('/orders/')) return { status: 200, body: { id: 'o1' } };
      return { status: 404, body: {} };
    };
    const collection: Collection = {
      id: 'c-chain',
      name: 'Chain',
      preRequestScript: "pm.variables.set('trace', 'run-' + pm.info.iteration);",
      items: [
        http('login', 'Login', {
          method: 'POST',
          url: '{{baseUrl}}/login',
          testScript:
            "pm.collectionVariables.set('token', pm.response.json().token); pm.test('200', () => pm.response.to.have.status(200));",
        }),
        folder(
          'f-api',
          'API',
          [
            folder(
              'f-gql',
              'GraphQL',
              [
                http('me', 'Me', {
                  method: 'POST',
                  url: '{{baseUrl}}/graphql',
                  body: { type: 'graphql', raw: '{ me { id } }' },
                  testScript:
                    "pm.variables.set('userId', pm.response.json().data.me.id); pm.test('me', () => pm.response.to.have.status(200));",
                }),
              ],
              { variables: [{ id: 'v-inner', key: 'scope', value: 'inner', enabled: true }] }
            ),
            http('order', 'Order', {
              url: '{{baseUrl}}/orders/{{userId}}?scope={{scope}}',
            }),
          ],
          {
            auth: { type: 'bearer', bearer: { token: '{{token}}' } },
            variables: [{ id: 'v-outer', key: 'scope', value: 'outer', enabled: true }],
          }
        ),
      ],
    };
    const result = await run(collection);
    expect(result.requests.map((r) => [r.itemName, r.status, r.error])).toEqual([
      ['Login', 'success', undefined],
      ['Me', 'success', undefined],
      ['Order', 'success', undefined],
    ]);
    const order = sent.find((s) => s.url.includes('/orders/'));
    // The inner folder's `scope` is not visible to a sibling of that folder.
    expect(order?.url).toBe('https://api.test/orders/u1?scope=outer');
    const me = sent.find((s) => s.url.endsWith('/graphql'));
    expect(JSON.parse(me?.data ?? '{}')).toMatchObject({ query: '{ me { id } }' });
    expect(order?.headers.Authorization).toBe('Bearer T-123');
  });
});
