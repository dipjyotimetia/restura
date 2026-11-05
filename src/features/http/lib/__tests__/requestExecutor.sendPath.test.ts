import { GRAPHQL_ACCEPT } from '@shared/graphql/wire';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { HttpRequest } from '@/types';

const executeProxiedRequestMock = vi.fn();
const executeProxiedStreamingRequestMock = vi.fn();

vi.mock('@/lib/shared/transport', () => ({
  executeProxiedRequest: (...args: unknown[]) => executeProxiedRequestMock(...args),
  executeProxiedStreamingRequest: (...args: unknown[]) =>
    executeProxiedStreamingRequestMock(...args),
  ProxyTransportError: class ProxyTransportError extends Error {},
}));

vi.mock('@/features/scripts/lib/pmSendRequestHost', () => ({
  makeRendererSendRequest: () => vi.fn(),
}));

import { executeRequest } from '../requestExecutor';

function makeRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id: 'request-id',
    name: 'Send path',
    type: 'http',
    method: 'POST',
    url: 'https://api.example.com/graphql',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

const settings = useSettingsStore.getState().settings;
const resolveVariables = (text: string, vars?: Record<string, string>) =>
  text.replace(/\{\{(\w+)\}\}/g, (m, name: string) => vars?.[name] ?? m);

interface SentSpec {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyType?: string;
  data?: string;
  streamingMode?: boolean;
}

function sentSpec(): SentSpec {
  return executeProxiedRequestMock.mock.calls[0]?.[0] as SentSpec;
}

beforeEach(() => {
  executeProxiedRequestMock.mockReset();
  executeProxiedStreamingRequestMock.mockReset();
  executeProxiedRequestMock.mockResolvedValue({
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    data: '{"data":{}}',
    size: 11,
  });
});

describe('executeRequest — GraphQL body on the HTTP send path', () => {
  it('sends the {query, variables, operationName} envelope, not the bare document', async () => {
    const query = 'query Me($id: ID!) { me(id: $id) { id } }';
    const result = await executeRequest({
      request: makeRequest({
        body: { type: 'graphql', raw: query, graphqlVariables: '{"id":"{{uid}}"}' },
      }),
      envVars: { uid: 'a"b' },
      globalSettings: settings,
      resolveVariables,
    });
    const spec = sentSpec();
    expect(spec.bodyType).toBe('json');
    // JSON-safe substitution: a value holding `"` can't break the variables JSON.
    expect(JSON.parse(spec.data ?? '')).toEqual({
      query,
      variables: { id: 'a"b' },
      operationName: 'Me',
    });
    expect(spec.headers['Content-Type']).toBe('application/json');
    expect(spec.headers.Accept).toBe(GRAPHQL_ACCEPT);
    expect(result.sentBody).toBe(spec.data);
  });

  it('a GET carries the resolved document in the URL', async () => {
    await executeRequest({
      request: makeRequest({
        method: 'GET',
        body: { type: 'graphql', raw: '{ echo(text: "{{word}}") }' },
      }),
      envVars: { word: 'hi' },
      globalSettings: settings,
      resolveVariables,
    });
    const url = new URL(sentSpec().url);
    expect(sentSpec().method).toBe('GET');
    expect(url.searchParams.get('query')).toBe('{ echo(text: "hi") }');
    expect(sentSpec().bodyType).toBe('none');
  });

  it('refuses invalid variables JSON before anything is sent', async () => {
    await expect(
      executeRequest({
        request: makeRequest({
          body: { type: 'graphql', raw: '{ me { id } }', graphqlVariables: '{nope' },
        }),
        envVars: {},
        globalSettings: settings,
        resolveVariables,
      })
    ).rejects.toThrow(/Invalid JSON in GraphQL variables/);
    expect(executeProxiedRequestMock).not.toHaveBeenCalled();
  });
});

describe('executeRequest — streaming Accept on the web buffered path', () => {
  it.each(['application/x-ndjson', 'text/event-stream', 'application/jsonl'])(
    'reads %s through the pass-through stream instead of an empty buffered reply',
    async (accept) => {
      executeProxiedStreamingRequestMock.mockResolvedValue(
        new Response('{"a":1}\n{"a":2}\n', { status: 200, headers: { 'content-type': accept } })
      );
      const result = await executeRequest({
        request: makeRequest({
          method: 'GET',
          headers: [{ id: 'a', key: 'accept', value: accept, enabled: true }],
        }),
        envVars: {},
        globalSettings: settings,
        resolveVariables,
      });
      expect(executeProxiedRequestMock).not.toHaveBeenCalled();
      expect(executeProxiedStreamingRequestMock.mock.calls[0]?.[0]).toMatchObject({
        streamingMode: true,
      });
      expect(result.response.status).toBe(200);
      expect(result.response.body).toBe('{"a":1}\n{"a":2}\n');
    }
  );
});

describe('executeRequest — auth header replaces a same-name user header', () => {
  it('sends one Authorization, from the auth tab', async () => {
    await executeRequest({
      request: makeRequest({
        method: 'GET',
        headers: [{ id: 'h', key: 'authorization', value: 'Bearer from-row', enabled: true }],
        auth: { type: 'bearer', bearer: { token: 'from-auth-tab' } },
      }),
      envVars: {},
      globalSettings: settings,
      resolveVariables,
    });
    const names = Object.keys(sentSpec().headers).filter(
      (k) => k.toLowerCase() === 'authorization'
    );
    expect(names).toEqual(['Authorization']);
    expect(sentSpec().headers.Authorization).toBe('Bearer from-auth-tab');
  });
});

describe('executeRequest — test-phase rs.request is what was sent (CLI parity)', () => {
  it('gives the test script the resolved URL and header values', async () => {
    const result = await executeRequest({
      request: makeRequest({
        method: 'GET',
        url: 'https://api.example.com/{{path}}',
        headers: [{ id: 'h', key: 'X-Tok', value: '{{tok}}', enabled: true }],
        testScript: `
          pm.environment.set('seenUrl', pm.request.url.toString());
          pm.environment.set('seenTok', pm.request.headers.get('X-Tok'));
        `,
      }),
      envVars: { path: 'users', tok: 't-1' },
      globalSettings: settings,
      resolveVariables,
    });
    expect(result.environmentMutations).toMatchObject({
      seenUrl: 'https://api.example.com/users',
      seenTok: 't-1',
    });
  });
});
