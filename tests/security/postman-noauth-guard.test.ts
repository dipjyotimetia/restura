import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PostmanAuthBlockedError,
  resolveInheritedAuthFor,
  resolveInheritedAuthForSend,
} from '@/features/auth/lib/resolveInheritedAuthFor';
import { flattenRunnables } from '@/features/collections/lib/flattenRunnables';
import { introspectSchema } from '@/features/graphql/lib/introspection';
import { prepareSubscriptionHandshake } from '@/features/graphql/lib/subscriptionAuth';
import { startGrpcStream } from '@/features/grpc/lib/grpcStreamingClient';
import { executeRequest, executeStreamingRequest } from '@/features/http/lib/requestExecutor';
import { buildMcpRunConnectAuth } from '@/features/mcp/lib/mcpRunRequest';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { importPostmanCollection } from '../../shared/collections/postman';
import { postmanBlockedReasonFor } from '../../shared/collections/postman/auth-guard';
import type { Collection, CollectionItem, HttpRequest } from '../../shared/types';

/**
 * Restura's `{ type: 'none' }` means *inherit*. An explicit Postman `noauth`
 * (or an unsupported Postman auth such as hawk) must therefore never let an
 * ancestor's credential be substituted at send time: Postman would send no
 * credential (or a hawk signature), never the collection's bearer token
 * (#1228, #1232). Every app send path refuses instead.
 */

const SECRET = 'collection-secret';
const V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

const v2 = {
  info: { name: 'V2', schema: V21 },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: SECRET }] },
  item: [
    {
      name: 'Noauth folder',
      auth: { type: 'noauth' },
      item: [{ name: 'Folder child', request: { method: 'GET', url: 'https://x.example/a' } }],
    },
    {
      name: 'Noauth request',
      request: { method: 'GET', url: 'https://x.example/b', auth: { type: 'noauth' } },
    },
    {
      name: 'Hawk folder',
      auth: { type: 'hawk', hawk: [{ key: 'authId', value: 'id' }] },
      item: [{ name: 'Hawk child', request: { method: 'GET', url: 'https://x.example/c' } }],
    },
    { name: 'Control', request: { method: 'GET', url: 'https://x.example/d' } },
  ],
};

const v3 = {
  $kind: 'collection',
  name: 'V3',
  auth: { type: 'bearer', credentials: [{ key: 'token', value: SECRET }] },
  items: [
    {
      $kind: 'collection',
      name: 'Noauth folder',
      auth: { type: 'noauth' },
      items: [{ $kind: 'http-request', name: 'Folder child', method: 'GET', url: 'https://x/a' }],
    },
    {
      $kind: 'http-request',
      name: 'Noauth request',
      method: 'GET',
      url: 'https://x/b',
      auth: { type: 'noauth' },
    },
    {
      $kind: 'collection',
      name: 'Hawk folder',
      auth: { type: 'hawk', credentials: [{ key: 'authId', value: 'id' }] },
      items: [{ $kind: 'http-request', name: 'Hawk child', method: 'GET', url: 'https://x/c' }],
    },
    { $kind: 'http-request', name: 'Control', method: 'GET', url: 'https://x/d' },
  ],
};

function find(items: CollectionItem[], name: string): CollectionItem | undefined {
  for (const item of items) {
    if (item.name === name) return item;
    const hit = item.items ? find(item.items, name) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

function req(c: Collection, name: string): HttpRequest {
  return find(c.items, name)?.request as HttpRequest;
}

/**
 * The stored request as a tab would send it: own auth `none` (a tab's
 * request keeps its own auth; inheritance is resolved at send time).
 */
function asTab(c: Collection, name: string): HttpRequest {
  return { ...req(c, name), auth: { type: 'none' } };
}

const BLOCKED = ['Folder child', 'Noauth request', 'Hawk child'];

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  useCollectionStore.setState({ collections: [], activeCollectionId: null });
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network must not be used'));
});
afterEach(() => {
  fetchSpy.mockRestore();
});

describe.each([
  ['v2.1', v2],
  ['v3', v3],
])('Postman %s: noauth / unsupported auth never receives an ancestor credential', (_l, doc) => {
  const load = () => {
    const { collection, report } = importPostmanCollection(doc);
    useCollectionStore.getState().addCollection(collection);
    return { collection, report };
  };

  it('import: explicit noauth is marked and cuts inheritance; children are not baked with the bearer', () => {
    const { collection, report } = load();
    const folder = find(collection.items, 'Noauth folder') as CollectionItem & {
      _postman?: { noauth?: true };
    };
    const own = find(collection.items, 'Noauth request') as CollectionItem & {
      _postman?: { noauth?: true };
    };
    expect(folder._postman?.noauth).toBe(true);
    expect(own._postman?.noauth).toBe(true);
    for (const name of BLOCKED) {
      expect(JSON.stringify(req(collection, name).auth)).not.toContain(SECRET);
    }
    expect(req(collection, 'Control').auth.type).toBe('bearer');
    const noauthWarnings = report.warnings
      .filter((w) => w.kind === 'unmodelled-construct' && w.construct === 'explicit-noauth')
      .map((w) => ('requestName' in w ? w.requestName : ''));
    expect(noauthWarnings).toEqual(['Noauth folder', 'Noauth request']);
  });

  it('single send: the inherited credential is withheld and the shared guard names the reason', () => {
    const { collection } = load();
    for (const name of BLOCKED) {
      const tab = asTab(collection, name);
      expect(resolveInheritedAuthFor(tab)).toBeUndefined();
      expect(postmanBlockedReasonFor(collection, tab.id, 'Restura')).toMatch(/^not sent: /);
    }
    expect(resolveInheritedAuthFor(asTab(collection, 'Control'))?.auth.type).toBe('bearer');
    expect(postmanBlockedReasonFor(collection, req(collection, 'Control').id, 'Restura')).toBe(
      undefined
    );
  });

  it.each(BLOCKED)('single send (executeRequest) refuses "%s" and sends nothing', async (name) => {
    const { collection } = load();
    await expect(
      executeRequest({
        request: asTab(collection, name),
        envVars: {},
        globalSettings: useSettingsStore.getState().settings,
        resolveVariables: (text) => text,
      })
    ).rejects.toThrow(/not sent: Postman auth/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('streaming send (executeStreamingRequest) refuses too', async () => {
    const { collection } = load();
    await expect(
      executeStreamingRequest({
        request: asTab(collection, 'Noauth request'),
        envVars: {},
        globalSettings: useSettingsStore.getState().settings,
        resolveVariables: (text) => text,
      })
    ).rejects.toThrow(/not sent: Postman auth/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('collection runner: blocked items carry the reason and no inherited credential', () => {
    const { collection } = load();
    const runnables = flattenRunnables(collection.items, undefined, {}, collection.auth);
    for (const name of BLOCKED) {
      const r = runnables.find((x) => x.name === name);
      expect(r?.blocked).toMatch(/^not sent: /);
      expect(r?.inheritedAuth).toEqual({ type: 'none' });
    }
    const control = runnables.find((x) => x.name === 'Control');
    expect(control?.blocked).toBeUndefined();
  });
});

describe('non-HTTP single sends refuse a blocked request instead of sending `none` (#1232)', () => {
  const seed = (request: object) => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c',
          name: 'Col',
          auth: { type: 'bearer', bearer: { token: SECRET } },
          items: [
            {
              id: 'hf',
              name: 'HF',
              type: 'folder',
              _postman: { auth: { type: 'hawk' } },
              items: [{ id: 'i', name: 'R', type: 'request', request }],
            },
          ],
        } as unknown as Collection,
      ],
      activeCollectionId: null,
    });
  };
  const http = (): HttpRequest => ({
    id: 'blocked-1',
    name: 'R',
    type: 'http',
    method: 'POST',
    url: 'https://x.example/graphql',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  });
  const REASON = /not sent: Postman auth type "hawk" \(inherited from "HF"\)/;

  it('resolveInheritedAuthForSend throws PostmanAuthBlockedError; sendable requests pass', () => {
    seed(http());
    expect(() => resolveInheritedAuthForSend(http())).toThrow(PostmanAuthBlockedError);
    expect(resolveInheritedAuthForSend({ id: 'unknown', auth: { type: 'none' } })).toBeUndefined();
  });

  it('gRPC streams reject before connecting', async () => {
    const grpc = {
      id: 'blocked-1',
      name: 'R',
      type: 'grpc',
      url: 'grpc.example:443',
      auth: { type: 'none' },
    };
    seed(grpc);
    await expect(
      startGrpcStream({ request: grpc as never, resolveVariables: (t) => t })
    ).rejects.toThrow(REASON);
  });

  it('MCP connect auth fails closed with the reason', () => {
    const mcp = { id: 'blocked-1', name: 'R', type: 'mcp', auth: { type: 'none' }, headers: [] };
    seed(mcp);
    expect(buildMcpRunConnectAuth(mcp as never)).toEqual({
      ok: false,
      error: expect.stringMatching(REASON),
    });
  });

  it('GraphQL introspection fails with the reason and subscriptions refuse', async () => {
    seed(http());
    const result = await introspectSchema('https://x.example/graphql', { request: http() });
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(REASON) });
    expect(() => prepareSubscriptionHandshake(http())).toThrow(REASON);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('a noauth request with no configured auth anywhere is still sendable', () => {
  const doc = {
    info: { name: 'Open', schema: V21 },
    item: [
      {
        name: 'Open folder',
        auth: { type: 'noauth' },
        item: [{ name: 'Open child', request: { method: 'GET', url: 'https://x.example/o' } }],
      },
      {
        name: 'Open request',
        request: { method: 'GET', url: 'https://x.example/p', auth: { type: 'noauth' } },
      },
    ],
  };

  it('is not blocked by the guard, the runner, or reported', () => {
    const { collection, report } = importPostmanCollection(doc);
    useCollectionStore.getState().addCollection(collection);
    for (const name of ['Open child', 'Open request']) {
      expect(postmanBlockedReasonFor(collection, req(collection, name).id, 'Restura')).toBe(
        undefined
      );
    }
    expect(flattenRunnables(collection.items).every((r) => r.blocked === undefined)).toBe(true);
    expect(report.warnings).toEqual([]);
  });
});
