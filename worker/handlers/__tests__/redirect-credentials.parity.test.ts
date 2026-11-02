// @vitest-environment node
//
// Redirect header handling through the Worker route, which self-host shares. The
// table lives in shared/protocol/__tests__/redirect-credentials.fixture.ts.
import {
  API_KEY_AUTH,
  KEPT_ON_ORIGIN_CHANGE,
  OTHER_ORIGIN,
  REDIRECT_START,
  SAME_ORIGIN,
  SENT_HEADERS,
  STRIPPED_ON_ORIGIN_CHANGE,
  WSSE_AUTH,
} from '@shared/protocol/__tests__/redirect-credentials.fixture';
import { authHeaderNames } from '@shared/protocol/request-spec';
import type { AuthConfig } from '@shared/types';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProxyHandler } from '../proxy';

const tcpProxyStub = {
  httpsViaConnectProxy: () => {
    throw new Error('not used');
  },
  httpViaProxy: () => {
    throw new Error('not used');
  },
};
const app = new Hono<{ Bindings: { ENVIRONMENT?: string } }>();
app.post('/proxy', createProxyHandler(tcpProxyStub));

async function secondHopHeaders(location: string, auth: AuthConfig): Promise<string[]> {
  const seen: Headers[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return seen.length === 1
        ? new Response(null, { status: 302, headers: { location } })
        : new Response('ok', { status: 200 });
    })
  );
  const names = authHeaderNames(auth);
  const res = await app.request(
    '/proxy',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'GET',
        url: REDIRECT_START,
        headers: { ...SENT_HEADERS, ...(auth.type === 'api-key' ? { 'X-Unusual': 'v' } : {}) },
        auth,
        ...(names.length > 0 ? { redirectPolicy: { stripOnOriginChange: names } } : {}),
      }),
    },
    {}
  );
  expect(res.status).toBe(200);
  return [...(seen[1] as Headers).keys()];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('redirect headers: Worker and self-host', () => {
  it('removes credentials on an origin change and keeps the rest', async () => {
    const names = await secondHopHeaders(OTHER_ORIGIN, API_KEY_AUTH);
    for (const name of KEPT_ON_ORIGIN_CHANGE) expect(names).toContain(name);
    for (const name of STRIPPED_ON_ORIGIN_CHANGE) expect(names).not.toContain(name);
  });

  it('removes a header sign-at-wire auth added', async () => {
    const names = await secondHopHeaders(OTHER_ORIGIN, WSSE_AUTH);
    expect(names).not.toContain('x-wsse');
    for (const name of KEPT_ON_ORIGIN_CHANGE) expect(names).toContain(name);
  });

  it('keeps every header on the same origin', async () => {
    const names = await secondHopHeaders(SAME_ORIGIN, API_KEY_AUTH);
    // Proxy-Authorization never goes upstream, on any hop.
    const expected = STRIPPED_ON_ORIGIN_CHANGE.filter((name) => name !== 'proxy-authorization');
    for (const name of [...KEPT_ON_ORIGIN_CHANGE, ...expected]) expect(names).toContain(name);
  });
});
