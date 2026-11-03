import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunContext } from '@/features/registry/types';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { Response as ApiResponse, AuthConfig, Collection, HttpRequest } from '@/types';
import type { RunnableRequest } from '../flattenRunnables';

// Each send records the auth it was given and "refreshes" it: the refresh token
// rotates, so a send that reuses an old refresh token is detectable.
const sentAuth: AuthConfig[] = [];
let generation = 0;

const runRequestMock = vi.fn(async (req: HttpRequest, ctx: RunContext): Promise<ApiResponse> => {
  sentAuth.push(req.auth);
  generation += 1;
  ctx.onAuthRefreshed?.({
    ...req.auth,
    oauth2: {
      ...(req.auth.oauth2 ?? { accessToken: '' }),
      accessToken: `at-${generation}`,
      refreshToken: `rt-${generation}`,
    },
  });
  return {
    id: 'r',
    requestId: req.id,
    status: 200,
    statusText: 'OK',
    headers: {},
    body: '',
    size: 0,
    time: 1,
    timestamp: Date.now(),
  };
});

vi.mock('@/features/registry/registry', () => ({
  protocolRegistry: {
    get: (id: string) =>
      id === 'http'
        ? { id: 'http', runRequest: runRequestMock, injectVariables: (r: unknown) => r }
        : undefined,
  },
}));

import { runCollection } from '../collectionRunner';

const oauth2 = (rt: string): AuthConfig => ({
  type: 'oauth2',
  oauth2: { accessToken: 'at-0', refreshToken: rt, tokenUrl: 'https://idp.test/token' },
});

function httpReq(id: string, auth: AuthConfig): HttpRequest {
  return {
    id,
    name: id,
    type: 'http',
    method: 'GET',
    url: 'https://example.test',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth,
  };
}

function run(collection: Collection, runnables: RunnableRequest[], iterations: number) {
  return runCollection(
    {
      collection,
      scopeName: collection.name,
      runnables,
      baseVars: {},
      iterations,
      dataRows: [],
      delayMs: 0,
      stopOnFailure: false,
    },
    () => {},
    new AbortController().signal
  );
}

beforeEach(() => {
  sentAuth.length = 0;
  generation = 0;
  runRequestMock.mockClear();
});

describe('runCollection OAuth2 refresh', () => {
  it('persists a refreshed token onto a request that owns its oauth2 auth and reuses it next iteration', async () => {
    const owned = httpReq('req-1', oauth2('rt-0'));
    const collection: Collection = {
      id: 'c',
      name: 'C',
      items: [{ id: 'item-1', name: 'owned', type: 'request', request: owned }],
    };
    useCollectionStore.setState({ collections: [collection], activeCollectionId: null });

    await run(collection, [{ itemId: 'item-1', name: 'owned', request: owned }], 2);

    expect(sentAuth.map((a) => a.oauth2?.refreshToken)).toEqual(['rt-0', 'rt-1']);
    const stored = useCollectionStore.getState().collections[0]?.items[0]?.request;
    if (stored?.type !== 'http') throw new Error('expected the saved HTTP request');
    expect(stored.auth.oauth2?.refreshToken).toBe('rt-2');
    expect(stored.auth.oauth2?.accessToken).toBe('at-2');
  });

  it('never materialises a refreshed inherited auth onto the request, but rotates it within the run', async () => {
    const inherited = oauth2('rt-0');
    const child = httpReq('req-2', { type: 'none' });
    const collection: Collection = {
      id: 'c2',
      name: 'C2',
      auth: inherited,
      items: [{ id: 'item-2', name: 'child', type: 'request', request: child }],
    };
    useCollectionStore.setState({ collections: [collection], activeCollectionId: null });

    await run(collection, [{ itemId: 'item-2', name: 'child', request: child }], 2);

    expect(sentAuth.map((a) => a.oauth2?.refreshToken)).toEqual(['rt-0', 'rt-1']);
    const stored = useCollectionStore.getState().collections[0];
    const storedChild = stored?.items[0]?.request;
    if (storedChild?.type !== 'http') throw new Error('expected the saved HTTP request');
    expect(storedChild.auth).toEqual({ type: 'none' });
    expect(stored?.auth).toEqual(inherited);
  });
});
