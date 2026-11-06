// Query strings as the server reads them: the renderer's spec goes through the
// shared proxy core with a capturing fetcher, and the wire URL is parsed back
// with URLSearchParams.
import { buildGraphQLWireRequest } from '@shared/graphql/wire';
import { executeHttpProxy } from '@shared/protocol/http-proxy';
import type { Fetcher, FetcherRequest, RequestSpec } from '@shared/protocol/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { HttpRequest } from '@/types';

const executeProxiedRequestMock = vi.fn();

vi.mock('@/lib/shared/transport', () => ({
  executeProxiedRequest: (...args: unknown[]) => executeProxiedRequestMock(...args),
  executeProxiedStreamingRequest: vi.fn(),
  ProxyTransportError: class ProxyTransportError extends Error {},
}));

vi.mock('@/features/scripts/lib/pmSendRequestHost', () => ({
  makeRendererSendRequest: () => vi.fn(),
}));

import { executeRequest } from '../requestExecutor';

function makeRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id: 'request-id',
    name: 'query wire',
    type: 'http',
    method: 'GET',
    url: 'https://api.example.com/graphql',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

async function send(request: HttpRequest, extra: Record<string, unknown> = {}) {
  await executeRequest({
    request,
    envVars: {},
    globalSettings: useSettingsStore.getState().settings,
    resolveVariables: (text) => text,
    ...extra,
  });
  return executeProxiedRequestMock.mock.calls.at(-1)?.[0] as RequestSpec;
}

/** Run the spec through the shared proxy core and return the URL the fetcher saw. */
async function wireUrl(spec: RequestSpec): Promise<URL> {
  let seen: FetcherRequest | undefined;
  const fetcher: Fetcher = async (req) => {
    seen = req;
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      text: async () => '',
      contentLengthHeader: '0',
      body: null,
    };
  };
  const r = await executeHttpProxy(spec, fetcher, { allowLocalhost: true });
  expect(r.ok).toBe(true);
  return new URL(seen?.url ?? '');
}

const DOCUMENT = '# c\nquery Q($phone: String) {\n\tid\n  name(x: "%41 & #y")\n}';
const VARIABLES = { phone: '+15551234', pct: '%41', amp: 'a&b=c', sp: 'a b' };

beforeEach(() => {
  executeProxiedRequestMock.mockReset();
  executeProxiedRequestMock.mockResolvedValue({
    status: 200,
    statusText: 'OK',
    headers: {},
    data: '',
    size: 0,
  });
});

describe('executeRequest — GraphQL GET params on the wire', () => {
  it('sends the exact query document and variables (fully encoded)', async () => {
    const wire = buildGraphQLWireRequest(makeRequest({ params: [] }), {
      query: DOCUMENT,
      variables: VARIABLES,
      operationName: 'Q',
    });
    if (!wire.ok) throw new Error(wire.error);
    const url = await wireUrl(await send(wire.request));
    expect(url.searchParams.get('query')).toBe(DOCUMENT);
    expect(JSON.parse(url.searchParams.get('variables') ?? 'null')).toEqual(VARIABLES);
    expect(url.searchParams.get('operationName')).toBe('Q');
  });

  it('keeps user-typed rows as typed next to the built params', async () => {
    const wire = buildGraphQLWireRequest(
      makeRequest({
        params: [{ id: 'u', key: 'tag', value: 'a+b,c:d/%20', enabled: true }],
      }),
      { query: '{ a }' }
    );
    if (!wire.ok) throw new Error(wire.error);
    const url = await wireUrl(await send(wire.request));
    expect(url.search).toBe('?tag=a+b,c:d/%20&query=%7B%20a%20%7D');
  });
});

describe('executeRequest — API key in query', () => {
  it('replaces a same-named query row instead of sending the key twice', async () => {
    const spec = await send(
      makeRequest({
        url: 'https://api.example.com/x',
        params: [
          { id: '1', key: 'api_key', value: 'stale', enabled: true },
          { id: '2', key: 'other', value: '1', enabled: true },
          { id: '3', key: 'api_key', value: 'stale2', enabled: true },
        ],
        auth: { type: 'api-key', apiKey: { key: 'api_key', value: 'fresh', in: 'query' } },
      })
    );
    const url = await wireUrl(spec);
    expect(url.searchParams.getAll('api_key')).toEqual(['fresh']);
    expect(url.searchParams.getAll('other')).toEqual(['1']);
  });
});

describe('executeRequest — query rows holding a desktop secret-variable token', () => {
  // Pinned current behaviour: such rows travel in `spec.params` (a Record) so
  // Electron main can substitute the secret there and the proxy escapes it in
  // full. They go after the folded rows, and repeated names collapse to the
  // last row. See the comment at the fold in requestExecutor.ts.
  it('go in spec.params (after the folded rows, last repeated row wins), fully escaped', async () => {
    const spec = await send(
      makeRequest({
        url: 'https://api.example.com/x',
        params: [
          { id: '1', key: 'k', value: '{{sec}}', enabled: true },
          { id: '2', key: 'plain', value: 'a+b', enabled: true },
          { id: '3', key: 'k', value: 'x{{sec}}', enabled: true },
        ],
      }),
      { secretVariables: { sec: { kind: 'handle', id: 'h1' } } }
    );
    expect(spec.url).toBe('https://api.example.com/x?plain=a+b');
    expect(spec.params).toEqual({ k: 'x{{sec}}' });
    // Main substitutes the token; the proxy then escapes the whole value.
    const url = await wireUrl({ ...spec, params: { k: 'x+y&z' } });
    expect(url.search).toBe('?plain=a+b&k=x%2By%26z');
  });
});

describe('executeRequest — path variables', () => {
  it('substitutes :name segments from resolved rows, encoded, in the path only', async () => {
    const spec = await send(
      makeRequest({
        url: 'https://api.example.com:8443/users/:id/:off#:id',
        params: [{ id: 'q', key: 'q', value: ':id', enabled: true }],
        pathVariables: [
          { id: '1', key: 'id', value: '{{who}} 1', enabled: true },
          { id: '2', key: 'off', value: 'x', enabled: false },
        ],
      }),
      { envVars: { who: 'a/b' } }
    );
    expect(spec.url).toBe('https://api.example.com:8443/users/a%2Fb%201/:off?q=:id#:id');
  });

  it('keeps a desktop secret-variable token verbatim for main to substitute', async () => {
    const spec = await send(
      makeRequest({
        url: 'https://api.example.com/t/:tok',
        pathVariables: [{ id: '1', key: 'tok', value: 'x {{sec}}', enabled: true }],
      }),
      { secretVariables: { sec: { kind: 'handle', id: 'h1' } } }
    );
    expect(spec.url).toBe('https://api.example.com/t/x%20{{sec}}');
  });
});
