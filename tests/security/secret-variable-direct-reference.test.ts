// @vitest-environment jsdom
// Secret variables resolve only from a token written in the field being sent
// (ADR-0007, ADR-0039). A token that arrives through another variable's value
// fails the send, before anything reaches the transport.
import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxied = vi.hoisted(() => vi.fn());
const platform = vi.hoisted(() => ({ electron: true }));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn() } },
}));
vi.mock('../../electron/main/security/secret-handle-store', () => ({
  unwrapSecretValueMain: () => 'S3CRET',
}));
vi.mock('../../electron/main/security/external-secret-providers', () => ({
  desktopExternalSecretResolver: { resolve: vi.fn() },
}));
vi.mock('@/lib/shared/transport', () => ({
  executeProxiedRequest: (...args: unknown[]) => proxied(...args),
  executeProxiedStreamingRequest: vi.fn(),
  ProxyTransportError: class ProxyTransportError extends Error {},
}));
vi.mock('@/lib/shared/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/platform')>()),
  isElectron: () => platform.electron,
}));

import { SECRET_HANDLE_PLACEHOLDER } from '@shared/secrets/secret-ref';
import {
  materializeSecretVariables,
  type SecretVariableHttpConfig,
} from '../../electron/main/security/secret-variable-materializer';
import { SubscriptionAuthNotice } from '../../src/features/graphql/components/SubscriptionAuthNotice';
import { buildSubscriptionHandshake } from '../../src/features/graphql/lib/subscriptionAuth';
import { graphqlProtocol } from '../../src/features/graphql/protocol';
import { grpcProtocol } from '../../src/features/grpc/protocol';
import { executeRequest } from '../../src/features/http/lib/requestExecutor';
import { httpProtocol } from '../../src/features/http/protocol';
import { useCookieStore } from '../../src/features/http/store/useCookieStore';
import { runLoadTest } from '../../src/features/load-testing/lib/loadTestRunner';
import { injectMcpVariables } from '../../src/features/mcp/lib/mcpRunRequest';
import { injectString } from '../../src/features/workflows/lib/variableHelpers';
import { buildActiveRequestVariableResolution } from '../../src/lib/shared/activeRequestScopes';
import {
  getActiveStreamingVariableScope,
  resolveStreamingText,
} from '../../src/lib/shared/streaming/messageVariables';
import { useCollectionStore } from '../../src/store/useCollectionStore';
import { useEnvironmentStore } from '../../src/store/useEnvironmentStore';
import { useGlobalsStore } from '../../src/store/useGlobalsStore';
import { useRequestStore } from '../../src/store/useRequestStore';
import { useSettingsStore } from '../../src/store/useSettingsStore';
import type { GrpcRequest, HttpRequest, McpRequest, ScopedVariable } from '../../src/types';

const HANDLE = { kind: 'handle', id: 'h-secret' } as const;
const handleRow: Partial<ScopedVariable> = {
  key: 'sec',
  value: SECRET_HANDLE_PLACEHOLDER,
  secretRef: HANDLE,
};
const plainRow: Partial<ScopedVariable> = {
  key: 'sec',
  value: 'PLAINTEXT',
  secret: true,
};
const alias: Partial<ScopedVariable> = {
  key: 'next',
  value: 'https://other.test/?k={{sec}}',
};
const REFUSAL = /Variable "next" references secret variable "sec".*can only be used where/;

function useEnvironment(variables: Partial<ScopedVariable>[]) {
  useEnvironmentStore.setState({
    activeEnvironmentId: 'env',
    environments: [
      {
        id: 'env',
        name: 'env',
        variables: variables.map((variable, index) => ({
          id: String(index),
          key: '',
          value: '',
          enabled: true,
          ...variable,
        })),
      },
    ],
  });
}

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id: 'r',
    name: 'r',
    type: 'http',
    method: 'POST',
    url: 'https://api.example.com/resource',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

const header = (value: string, key = 'X-Key') => ({
  id: key,
  key,
  value,
  enabled: true,
});

/** Send through the real executor with the real active-request scopes. */
async function send(req: HttpRequest) {
  const { values, secretVariables, sendSecretNames } = buildActiveRequestVariableResolution();
  proxied.mockClear();
  const result = await executeRequest({
    request: req,
    envVars: values,
    secretVariables,
    secretNames: sendSecretNames,
    globalSettings: useSettingsStore.getState().settings,
    resolveVariables: (text) => useEnvironmentStore.getState().resolveVariables(text),
  });
  return {
    result,
    spec: proxied.mock.calls[0]?.[0],
    desktop: proxied.mock.calls[0]?.[2],
  };
}

/** Run what the renderer produced through the real main-side materializer. */
async function materialize(
  spec: SecretVariableHttpConfig,
  desktop: Pick<SecretVariableHttpConfig, 'secretVariables'>
) {
  return materializeSecretVariables({ ...spec, ...desktop });
}

beforeEach(() => {
  platform.electron = true;
  useGlobalsStore.setState({ vars: {} });
  useCollectionStore.setState({ collections: [] } as never);
  useRequestStore.setState({ tabs: [], activeTabId: null } as never);
  useCookieStore.setState({ cookies: [] } as never);
  proxied.mockReset();
  proxied.mockResolvedValue({
    status: 200,
    statusText: 'OK',
    headers: {},
    data: '',
    size: 0,
  });
});

describe('a secret-handle variable written in the field', () => {
  beforeEach(() => useEnvironment([handleRow, alias]));

  for (const token of ['{{sec}}', '{{ sec }}', '{{\tsec\n}}']) {
    it(`materializes in main from the URL, header and body: ${JSON.stringify(token)}`, async () => {
      const { spec, desktop } = await send(
        request({
          url: `https://api.example.com/r?k=${token}`,
          headers: [header(`Bearer ${token}`)],
          body: { type: 'text', raw: token },
        })
      );
      expect(JSON.stringify(spec)).not.toContain('__restura_secret_');
      expect(JSON.stringify(spec)).not.toContain(SECRET_HANDLE_PLACEHOLDER);
      const out = await materialize(spec, desktop);
      expect(out.url).toBe('https://api.example.com/r?k=S3CRET');
      expect((out.headers as Record<string, string>)['X-Key']).toBe('Bearer S3CRET');
      expect(out.data).toBe('S3CRET');
    });
  }

  it('materializes in main from the auth fields', async () => {
    const { spec, desktop } = await send(
      request({
        auth: { type: 'basic', basic: { username: 'u', password: '{{sec}}' } },
      })
    );
    const out = await materialize(spec, desktop);
    expect((out.auth as unknown as { basic: { password: unknown } }).basic.password).toBe('S3CRET');
  });

  it('works under a spaced name', async () => {
    useEnvironment([{ ...handleRow, key: 'my secret' }]);
    const { spec, desktop } = await send(request({ headers: [header('{{ my secret }}')] }));
    const out = await materialize(spec, desktop);
    expect((out.headers as Record<string, string>)['X-Key']).toBe('S3CRET');
  });
});

describe('a secret-handle variable reached through a value', () => {
  for (const [label, rows] of [
    ['alias defined first', [alias, handleRow]],
    ['secret defined first', [handleRow, alias]],
  ] as const) {
    it(`refuses the URL before anything is sent: ${label}`, async () => {
      useEnvironment([...rows]);
      await expect(send(request({ url: '{{next}}' }))).rejects.toThrow(REFUSAL);
      expect(proxied).not.toHaveBeenCalled();
    });
  }

  it('refuses per field, even when another field uses the secret directly', async () => {
    useEnvironment([handleRow, alias]);
    await expect(
      send(
        request({
          url: '{{next}}',
          auth: { type: 'bearer', bearer: { token: '{{sec}}' } },
        })
      )
    ).rejects.toThrow(REFUSAL);
    expect(proxied).not.toHaveBeenCalled();
  });

  it.each([
    ['header', () => request({ headers: [header('{{next}}')] }), /in header "X-Key"/],
    [
      'query parameter',
      () =>
        request({
          params: [{ id: 'p', key: 'q', value: '{{next}}', enabled: true }],
        }),
      /in query parameter "q"/,
    ],
    ['body', () => request({ body: { type: 'text', raw: '{{next}}' } }), /in body/],
    ['auth', () => request({ auth: { type: 'bearer', bearer: { token: '{{next}}' } } }), /in auth/],
    ['URL', () => request({ url: 'https://a.test/{{next}}' }), /in URL/],
  ])('names the field and no value: %s', async (_name, build, field) => {
    useEnvironment([alias, handleRow]);
    const error = await send(build()).then(
      () => undefined,
      (cause: Error) => cause
    );
    expect(error?.message).toMatch(REFUSAL);
    expect(error?.message).toMatch(field);
    expect(error?.message).not.toContain('https://other.test');
    expect(error?.message).not.toContain(SECRET_HANDLE_PLACEHOLDER);
    expect(proxied).not.toHaveBeenCalled();
  });

  it('refuses a padded token in a value', async () => {
    useEnvironment([{ key: 'next', value: '{{  sec }}' }, handleRow]);
    await expect(send(request({ url: '{{next}}' }))).rejects.toThrow(REFUSAL);
  });

  it('refuses when a global holds the reference', async () => {
    useEnvironment([handleRow]);
    useGlobalsStore.setState({ vars: { next: '{{sec}}' } });
    await expect(send(request({ url: '{{next}}' }))).rejects.toThrow(REFUSAL);
  });

  it('refuses a token assembled from two values', async () => {
    useEnvironment([{ key: 'a', value: '{{' }, { key: 'b', value: 'sec}}' }, handleRow]);
    await expect(send(request({ url: '{{a}}{{b}}' }))).rejects.toThrow(/secret variable "sec"/);
  });

  it('keeps marker-shaped text in a value literal beside a direct token', async () => {
    useEnvironment([{ key: 'other', value: '__restura_secret_0__' }, handleRow]);
    const { spec, desktop } = await send(
      request({ body: { type: 'text', raw: '{{sec}}{{other}}' } })
    );
    const out = await materialize(spec, desktop);
    expect(out.data).toBe('S3CRET__restura_secret_0__');
  });

  it('refuses a pre-request script value', async () => {
    useEnvironment([handleRow]);
    await expect(
      send(
        request({
          url: '{{next}}',
          preRequestScript: `pm.environment.set('next', 'https://other.test/?k={{sec}}');`,
        })
      )
    ).rejects.toThrow(REFUSAL);
    expect(proxied).not.toHaveBeenCalled();
  });

  it('refuses a value persisted from an earlier response', async () => {
    useEnvironment([handleRow]);
    proxied.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: 'https://other.test/?k={{sec}}',
      size: 0,
    });
    const first = await send(
      request({
        testScript: `pm.environment.set('next', pm.response.text());`,
      })
    );
    const stored = first.result.scriptResult?.test?.variables?.['next'];
    expect(stored).toBe('https://other.test/?k={{sec}}');

    useEnvironment([handleRow, { key: 'next', value: stored as string }]);
    await expect(send(request({ url: '{{next}}' }))).rejects.toThrow(REFUSAL);
    expect(proxied).not.toHaveBeenCalled();
  });

  it('refuses a cookie jar entry holding a token', async () => {
    useEnvironment([handleRow]);
    useCookieStore.setState({
      cookies: [
        {
          id: 'c',
          key: 'jar',
          value: '{{sec}}',
          domain: 'api.example.com',
          path: '/',
          secure: true,
          httpOnly: false,
          lastAccessed: new Date().toISOString(),
        },
      ],
    } as never);
    await expect(send(request())).rejects.toThrow(/Cookie header.*secret variable "sec"/);
    expect(proxied).not.toHaveBeenCalled();
  });

  const jarWith = (cookies: Array<{ key: string; value: string }>) =>
    useCookieStore.setState({
      cookies: cookies.map((cookie, index) => ({
        id: String(index),
        domain: 'api.example.com',
        path: '/',
        secure: true,
        httpOnly: false,
        lastAccessed: new Date().toISOString(),
        ...cookie,
      })),
    } as never);

  it('refuses a cookie name holding a token', async () => {
    useEnvironment([handleRow]);
    jarWith([{ key: '{{sec}}', value: 'x' }]);
    await expect(send(request())).rejects.toThrow(/Cookie header.*secret variable "sec"/);
    expect(proxied).not.toHaveBeenCalled();
  });

  it('refuses a token formed by a cookie name and value', async () => {
    useEnvironment([{ ...handleRow, key: 'se=c' }]);
    jarWith([{ key: '{{se', value: 'c}}' }]);
    await expect(send(request())).rejects.toThrow(/Cookie header.*secret variable "se=c"/);
    expect(proxied).not.toHaveBeenCalled();
  });

  it('refuses a token formed across two cookies', async () => {
    useEnvironment([{ ...handleRow, key: 'a=1; b=' }]);
    jarWith([
      { key: '{{a', value: '1' },
      { key: 'b', value: '}}' },
    ]);
    await expect(send(request())).rejects.toThrow(/Cookie header.*secret variable "a=1; b="/);
    expect(proxied).not.toHaveBeenCalled();
  });

  it('sends ordinary cookies', async () => {
    useEnvironment([handleRow]);
    jarWith([{ key: 'session', value: 'abc' }]);
    const { spec } = await send(request());
    expect(spec.headers['Cookie']).toBe('session=abc');
  });

  it('refuses a refreshed token holding a token', async () => {
    useEnvironment([handleRow]);
    const endpoint = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: '{{sec}}' }), { status: 200 })
      );
    await expect(
      send(
        request({
          auth: {
            type: 'oauth2',
            oauth2: {
              accessToken: 'old',
              refreshToken: 'r',
              clientId: 'c',
              tokenUrl: 'https://a.test/token',
              expiresAt: 1,
            },
          },
        })
      )
    ).rejects.toThrow(/variable reference/);
    expect(proxied).not.toHaveBeenCalled();
    endpoint.mockRestore();
  });
});

describe.each([
  ['desktop', true],
  ['web', false],
])('a plaintext secret variable (%s)', (_name, electron) => {
  beforeEach(() => {
    platform.electron = electron;
  });

  for (const token of ['{{sec}}', '{{ sec }}']) {
    it(`substitutes where it is written: ${token}`, async () => {
      useEnvironment([plainRow, alias]);
      const { spec } = await send(
        request({
          url: `https://api.example.com/r?k=${token}`,
          headers: [header(token)],
          body: { type: 'text', raw: token },
          auth: { type: 'bearer', bearer: { token } },
        })
      );
      expect(spec.url).toBe('https://api.example.com/r?k=PLAINTEXT');
      expect(spec.headers['X-Key']).toBe('PLAINTEXT');
      expect(spec.headers['Authorization']).toBe('Bearer PLAINTEXT');
      expect(spec.data).toBe('PLAINTEXT');
    });
  }

  for (const [label, rows] of [
    ['alias defined first', [alias, plainRow]],
    ['secret defined first', [plainRow, alias]],
  ] as const) {
    it(`refuses through a value: ${label}`, async () => {
      useEnvironment([...rows]);
      await expect(send(request({ url: '{{next}}' }))).rejects.toThrow(REFUSAL);
      expect(proxied).not.toHaveBeenCalled();
    });
  }

  it('refuses when the store pass would answer the name', async () => {
    useEnvironment([plainRow]);
    useCollectionStore.setState({
      collections: [
        {
          id: 'c',
          name: 'c',
          variables: [
            { id: 'o', key: 'sec', value: 'collection-plain', enabled: true },
            { id: 'n', key: 'next', value: '{{sec}}', enabled: true },
          ],
          items: [{ id: 'req', name: 'r', type: 'request', request: { id: 'req' } }],
        },
      ],
    } as never);
    useRequestStore.setState({
      tabs: [
        {
          id: 't',
          request: { id: 'req' },
          isDirty: false,
          savedRequestId: 'req',
        },
      ],
      activeTabId: 't',
    } as never);
    await expect(send(request({ url: '{{next}}' }))).rejects.toThrow(REFUSAL);
    // Written directly, the winning row answers.
    const { spec } = await send(request({ body: { type: 'text', raw: '{{sec}}' } }));
    expect(spec.data).toBe('collection-plain');
  });

  it('still answers a direct token only the store knows', async () => {
    useEnvironmentStore.setState({
      activeEnvironmentId: 'env',
      environments: [
        {
          id: 'env',
          name: 'env',
          collectionId: 'other-collection',
          variables: [
            {
              id: '0',
              key: 'sec',
              value: 'PLAINTEXT',
              secret: true,
              enabled: true,
            },
          ],
        },
      ],
    } as never);
    const { spec } = await send(request({ body: { type: 'text', raw: '{{sec}}' } }));
    expect(spec.data).toBe('PLAINTEXT');
  });

  it('keeps non-secret chains in definition order', async () => {
    useEnvironment([plainRow, { key: 'a', value: '{{b}}' }, { key: 'b', value: 'v' }]);
    const { spec } = await send(request({ body: { type: 'text', raw: '{{a}} {{sec}}' } }));
    expect(spec.data).toBe('v PLAINTEXT');
  });
});

describe('a token formed from separate values', () => {
  it.each([
    ['handle', handleRow],
    ['plaintext', plainRow],
  ])('refuses adjacent variable values naming a %s secret', async (_name, secret) => {
    useEnvironment([{ key: 'a', value: '{{se' }, { key: 'b', value: 'c}}' }, secret]);
    await expect(send(request({ url: '{{a}}{{b}}' }))).rejects.toThrow(/secret variable "sec"/);
    expect(proxied).not.toHaveBeenCalled();
    expect(useEnvironmentStore.getState().resolveVariables('{{a}}{{b}}')).toBe('{{sec}}');
  });

  it('refuses a value completing a token written around it', async () => {
    useEnvironment([{ key: 'x', value: '' }, handleRow]);
    await expect(send(request({ url: '{{se{{x}}c}}' }))).rejects.toThrow(/secret variable "sec"/);
    expect(proxied).not.toHaveBeenCalled();
  });

  it('does not join an API key name and value into a token', async () => {
    useEnvironment([handleRow]);
    const { spec, desktop } = await send(
      request({
        auth: { type: 'api-key', apiKey: { key: '{{se', value: 'c}}', in: 'header' } },
      })
    );
    const out = await materialize(spec, desktop);
    expect((out.headers as Record<string, string>)['{{se']).toBe('c}}');
    expect(JSON.stringify(out)).not.toContain('S3CRET');
  });

  it('does not join Basic credentials into a token', async () => {
    useEnvironment([handleRow]);
    const { spec, desktop } = await send(
      request({ auth: { type: 'basic', basic: { username: '{{se', password: 'c}}' } } })
    );
    const out = await materialize(spec, desktop);
    expect(JSON.stringify(out)).not.toContain('S3CRET');
    expect((out.headers as Record<string, string>)['Authorization']).toBe(
      `Basic ${btoa('{{se:c}}')}`
    );
  });

  it('does not join a deferred Basic username and password in main', async () => {
    useEnvironment([handleRow]);
    const { spec, desktop } = await send(
      request({ auth: { type: 'basic', basic: { username: '{{sec}}', password: 'c}}' } } })
    );
    const out = await materialize(spec, desktop);
    const basic = (out.auth as unknown as { basic: { username: string; password: string } }).basic;
    expect(basic).toMatchObject({ username: 'S3CRET', password: 'c}}' });
  });
});

describe('store answers joined with the field text', () => {
  // The active environment belongs to another collection, so only the store
  // answers its secrets; the handle lives on the request's own collection.
  function install(rows: Partial<ScopedVariable>[]) {
    useEnvironmentStore.setState({
      activeEnvironmentId: 'env',
      environments: [
        {
          id: 'env',
          name: 'env',
          collectionId: 'other-collection',
          variables: rows.map((row, index) => ({
            id: String(index),
            key: '',
            value: '',
            enabled: true,
            secret: true,
            ...row,
          })),
        },
      ],
    } as never);
    useCollectionStore.setState({
      collections: [
        {
          id: 'c',
          name: 'c',
          variables: [{ id: 'h', ...handleRow, enabled: true }],
          items: [{ id: 'req', name: 'r', type: 'request', request: { id: 'req' } }],
        },
      ],
    } as never);
    useRequestStore.setState({
      tabs: [{ id: 't', request: { id: 'req' }, isDirty: false, savedRequestId: 'req' }],
      activeTabId: 't',
    } as never);
  }

  it.each([
    [
      'two answers',
      '{{a}}{{b}}',
      [
        { key: 'a', value: '{{se' },
        { key: 'b', value: 'c}}' },
      ],
    ],
    ['an answer and written text', '{{a}}}}', [{ key: 'a', value: '{{sec' }]],
    ['written text and an answer', '{{{{a}}', [{ key: 'a', value: 'sec}}' }]],
  ])('refuses a token formed by %s', async (_name, raw, rows) => {
    install(rows);
    await expect(send(request({ body: { type: 'text', raw } }))).rejects.toThrow(
      /secret variable "sec"/
    );
    expect(proxied).not.toHaveBeenCalled();
  });

  it('keeps a written handle token beside an answer, and main materializes only that', async () => {
    install([{ key: 'a', value: 'answer' }]);
    const { spec, desktop } = await send(request({ body: { type: 'text', raw: '{{a}}-{{sec}}' } }));
    expect(spec.data).toBe('answer-{{sec}}');
    const out = await materialize(spec, desktop);
    expect(out.data).toBe('answer-S3CRET');
  });
});

describe('a written secret name with no answer', () => {
  it('stays literal on the map walk and on the HTTP registry path', async () => {
    expect(injectString('{{sec}}', {}, ['sec'])).toBe('{{sec}}');
    expect(injectString('a {{ sec }} {{sec}}', {}, ['sec'])).toBe('a {{ sec }} {{sec}}');
    await httpProtocol.runRequest(request({ headers: [header('{{sec}}')] }), {
      signal: new AbortController().signal,
      variables: {},
      secretNames: ['sec'],
    });
    expect(proxied.mock.calls[0]?.[0].headers['X-Key']).toBe('{{sec}}');
  });
});

describe('redirect policy on the spec', () => {
  it('names the API key header', async () => {
    useEnvironment([{ key: 'name', value: 'X-Unusual' }]);
    const { spec } = await send(
      request({ auth: { type: 'api-key', apiKey: { key: '{{name}}', value: 'k', in: 'header' } } })
    );
    expect(spec.redirectPolicy?.stripOnOriginChange).toEqual(['X-Unusual']);
  });

  it('names nothing for other auth', async () => {
    useEnvironment([]);
    const query = await send(
      request({ auth: { type: 'api-key', apiKey: { key: 'k', value: 'v', in: 'query' } } })
    );
    expect(query.spec.redirectPolicy?.stripOnOriginChange).toBeUndefined();
    const bearer = await send(request({ auth: { type: 'bearer', bearer: { token: 't' } } }));
    expect(bearer.spec.redirectPolicy?.stripOnOriginChange).toBeUndefined();
  });
});

describe('scripts and sub-requests', () => {
  const subRequests = () => proxied.mock.calls.map((call) => JSON.stringify(call[0]));

  it.each([
    ['handle', handleRow],
    ['plaintext', plainRow],
  ])('a sub-request never resolves a %s secret from a script string', async (_name, secret) => {
    useEnvironment([secret, { key: 'plain', value: 'p' }]);
    await send(
      request({
        preRequestScript: `
          pm.sendRequest('https://other.test/?k={{sec}}', function () {});
          pm.sendRequest({ url: 'https://other.test/', headers: { X: '{{ sec }}' } }, function () {});
          pm.sendRequest('https://other.test/{{plain}}', function () {});
        `,
      })
    );
    const sent = subRequests();
    expect(proxied.mock.calls.some((call) => call[0].url === 'https://other.test/p')).toBe(true);
    expect(sent.join()).not.toContain('PLAINTEXT');
    expect(sent.filter((text) => text.includes('other.test'))).toHaveLength(1);
  });

  it('a sub-request to a URL from the response does not resolve a secret', async () => {
    useEnvironment([plainRow]);
    proxied.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: 'https://other.test/?k={{sec}}',
      size: 0,
    });
    await send(request({ testScript: `pm.sendRequest(pm.response.text(), function () {});` }));
    expect(proxied).toHaveBeenCalledTimes(1);

    proxied.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: 'https://other.test/ordinary',
      size: 0,
    });
    await send(request({ testScript: `pm.sendRequest(pm.response.text(), function () {});` }));
    expect(proxied).toHaveBeenCalledTimes(2);
  });

  it('inherited headers go out as the parent built them', async () => {
    useEnvironment([handleRow, { key: 'other', value: 'y' }]);
    await send(
      request({
        headers: [header('{{sec}} {{other}}')],
        testScript: `pm.sendRequest('https://api.example.com/other', function () {});`,
      })
    );
    expect(proxied.mock.calls[0]?.[0].headers['X-Key']).toBe('{{sec}} y');
    const sub = proxied.mock.calls[1];
    expect(sub?.[0].url).toBe('https://api.example.com/other');
    expect(sub?.[0].headers['X-Key']).toBe('{{sec}} y');
    expect(sub?.[2]).toBeUndefined();
  });

  it('a pre-request sub-request resolves inherited non-secret headers and leaves a secret token', async () => {
    useEnvironment([plainRow, { key: 'tok', value: 'abc' }]);
    await send(
      request({
        headers: [header('{{tok}}'), header('{{sec}}', 'X-Secret')],
        preRequestScript: `pm.sendRequest('https://api.example.com/other', function () {});`,
      })
    );
    const sub = proxied.mock.calls[0]?.[0];
    expect(sub.url).toBe('https://api.example.com/other');
    expect(sub.headers['X-Key']).toBe('abc');
    expect(sub.headers['X-Secret']).toBe('{{sec}}');
  });
});

describe('sub-request credential inheritance through a send', () => {
  const subHeaders = () => proxied.mock.calls[1]?.[0].headers as Record<string, string>;
  const testScript = (url: string) => `pm.sendRequest('${url}', function () {});`;

  it('inherits no parent header cross-origin', async () => {
    useEnvironment([plainRow]);
    await send(
      request({
        headers: [header('tenant', 'X-Tenant'), header('{{sec}}', 'X-Custom-Name')],
        auth: { type: 'api-key', apiKey: { key: 'X-Unusual', value: 'k', in: 'header' } },
        testScript: testScript('https://other.test/'),
      })
    );
    expect(proxied.mock.calls[0]?.[0].headers['X-Unusual']).toBe('k');
    expect(proxied.mock.calls[1]?.[0].url).toBe('https://other.test/');
    expect(subHeaders()).toEqual({});
  });

  it('drops the bearer header and cookies cross-origin', async () => {
    useEnvironment([]);
    useCookieStore.setState({
      cookies: [
        {
          id: 'c',
          key: 'session',
          value: 'abc',
          domain: 'api.example.com',
          path: '/',
          secure: true,
          httpOnly: false,
          lastAccessed: new Date().toISOString(),
        },
      ],
    } as never);
    await send(
      request({
        auth: { type: 'bearer', bearer: { token: 't' } },
        testScript: testScript('https://other.test/'),
      })
    );
    expect(subHeaders()['Authorization']).toBeUndefined();
    expect(subHeaders()['Cookie']).toBeUndefined();
  });

  it('keeps them on the same origin', async () => {
    useEnvironment([plainRow]);
    await send(
      request({
        headers: [header('{{sec}}', 'X-Custom-Name')],
        auth: { type: 'bearer', bearer: { token: 't' } },
        testScript: testScript('https://api.example.com/other'),
      })
    );
    expect(subHeaders()['Authorization']).toBe('Bearer t');
    expect(subHeaders()['X-Custom-Name']).toBe('PLAINTEXT');
  });

  it('applies the rule in a pre-request script against the template URL', async () => {
    useEnvironment([
      { key: 'host', value: 'api.example.com' },
      { key: 'tok', value: 't' },
    ]);
    await send(
      request({
        url: 'https://{{host}}/resource',
        headers: [header('Bearer {{tok}}', 'Authorization')],
        preRequestScript: `${testScript('https://{{host}}/other')} ${testScript('https://other.test/')}`,
      })
    );
    const [same, other] = proxied.mock.calls.map((call) => call[0]);
    expect(same.url).toBe('https://api.example.com/other');
    expect(same.headers['Authorization']).toBe('Bearer t');
    expect(other.url).toBe('https://other.test/');
    expect(other.headers['Authorization']).toBeUndefined();
  });
});

describe('script-written request fields', () => {
  const secretNames = ['sec'];
  const grpc = (preRequestScript: string, value = 'saved'): GrpcRequest =>
    ({
      id: 'g',
      name: 'g',
      type: 'grpc',
      methodType: 'unary',
      url: 'https://a.test',
      service: 's',
      method: 'm',
      metadata: [{ id: 'm', key: 'x-saved', value, enabled: true }],
      message: '{}',
      auth: { type: 'none' },
      preRequestScript,
    }) as unknown as GrpcRequest;
  const run = (request: GrpcRequest) => {
    platform.electron = false;
    return grpcProtocol
      .runRequest(request, {
        signal: new AbortController().signal,
        variables: { sec: 'PLAINTEXT', plain: 'v' },
        secretNames,
      })
      .then(
        () => undefined,
        (cause: Error) => cause
      );
  };
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    return () => fetchSpy.mockRestore();
  });

  it.each([
    ['a new key', `rs.request.metadata['x-new'] = '{{sec}}';`],
    ['an edited key', `rs.request.metadata['x-saved'] = 'a {{ sec }}';`],
    ['the headers alias', `rs.request.headers['x-new'] = '{{sec}}';`],
    ['a replaced map', `rs.request.metadata = { 'x-new': '{{sec}}' };`],
  ])('gRPC refuses a secret token from a script: %s', async (_name, script) => {
    const error = await run(grpc(script));
    expect(error?.message).toMatch(/rs\.request\.metadata references secret variable "sec"/);
    expect(error?.message).not.toContain('PLAINTEXT');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a token moved from another saved key', async () => {
    const error = await run(grpc(`rs.request.metadata['x-new'] = '{{sec}}';`, '{{sec}}'));
    expect(error?.message).toMatch(/secret variable "sec"/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['left in place', `rs.request.metadata['x-other'] = 'v';`],
    ['kept in an edit of the same key', `rs.request.metadata['x-saved'] = '{{sec}} more';`],
    ['non-secret token in a script value', `rs.request.metadata['x-new'] = '{{plain}}';`],
  ])('allows a token %s', async (_name, script) => {
    const error = await run(grpc(script, '{{sec}}'));
    expect(error?.message ?? '').not.toMatch(/secret variable/);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('HTTP ignores request edits from a script', async () => {
    useEnvironment([plainRow]);
    const { spec } = await send(
      request({
        preRequestScript: `
          pm.request.url = 'https://other.test/{{sec}}';
          pm.request.headers['X-New'] = '{{sec}}';
          pm.request.body = '{{sec}}';
        `,
      })
    );
    expect(spec.url).toBe('https://api.example.com/resource');
    expect(spec.headers['X-New']).toBeUndefined();
    expect(JSON.stringify(spec)).not.toContain('PLAINTEXT');
  });
});

describe('the store resolver never throws', () => {
  it('keeps a token reached through a value literal, in either order', () => {
    for (const secret of [handleRow, plainRow]) {
      useEnvironment([alias, secret]);
      expect(useEnvironmentStore.getState().resolveVariables('{{next}}')).toBe(
        'https://other.test/?k={{sec}}'
      );
      useEnvironment([secret, alias]);
      expect(useEnvironmentStore.getState().resolveVariables('{{next}}')).toBe(
        'https://other.test/?k={{sec}}'
      );
    }
  });

  it('answers a direct reference as before', () => {
    useEnvironment([handleRow, alias]);
    expect(useEnvironmentStore.getState().resolveVariables('{{ sec }}')).toBe(
      SECRET_HANDLE_PLACEHOLDER
    );
    useEnvironment([plainRow, alias]);
    expect(useEnvironmentStore.getState().resolveVariables('{{sec}}')).toBe('PLAINTEXT');
  });
});

describe('registry protocols', () => {
  const secretNames = ['sec'];
  const ctx = (variables: Record<string, string>, names?: readonly string[]) => ({
    signal: new AbortController().signal,
    variables,
    ...(names ? { secretNames: names } : {}),
  });
  // Insertion orders where a plain regex walk would reach the value.
  const SCOPES: Array<Record<string, string>> = [
    { next: '{{sec}}', sec: 'PLAINTEXT' },
    { sec: 'PLAINTEXT', other: '{{next}}', next: '{{sec}}' },
    { next: '{{sec}}', sec: 'PLAINTEXT', other: '{{next}}' },
  ];

  it('HTTP refuses through a value and substitutes a direct token', async () => {
    for (const variables of SCOPES) {
      await expect(
        httpProtocol.runRequest(
          request({ url: 'https://a.test/{{other}}{{next}}' }),
          ctx(variables, secretNames)
        )
      ).rejects.toThrow(/secret variable "sec"/);
    }
    expect(proxied).not.toHaveBeenCalled();
    await httpProtocol.runRequest(
      request({ headers: [header('{{sec}}')] }),
      ctx({ next: '{{sec}}', sec: 'PLAINTEXT' }, secretNames)
    );
    expect(proxied.mock.calls[0]?.[0].headers['X-Key']).toBe('PLAINTEXT');
  });

  it('GraphQL refuses through a value and keeps a direct handle for main', async () => {
    await expect(
      graphqlProtocol.runRequest(request({ url: '{{next}}' }), {
        ...ctx({ next: '{{sec}}' }, secretNames),
        secretVariables: { sec: HANDLE },
      })
    ).rejects.toThrow(/secret variable "sec"/);
    expect(proxied).not.toHaveBeenCalled();
    await graphqlProtocol.runRequest(request({ headers: [header('{{sec}}')] }), {
      ...ctx({}, secretNames),
      secretVariables: { sec: HANDLE },
    });
    expect(proxied.mock.calls[0]?.[0].headers['X-Key']).toBe('{{sec}}');
  });

  it('gRPC refuses through a value before anything is sent', async () => {
    platform.electron = false;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const grpc = {
      id: 'g',
      name: 'g',
      type: 'grpc',
      methodType: 'unary',
      url: 'https://a.test',
      service: 's',
      method: 'm',
      metadata: [{ id: 'm', key: 'x', value: '{{next}}', enabled: true }],
      message: '{}',
      auth: { type: 'none' },
    } as unknown as GrpcRequest;
    for (const variables of SCOPES) {
      await expect(grpcProtocol.runRequest(grpc, ctx(variables, secretNames))).rejects.toThrow(
        /secret variable "sec"/
      );
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('MCP and injectString refuse through a value and substitute a direct token', () => {
    const mcp = {
      id: 'm',
      name: 'm',
      type: 'mcp',
      url: '{{next}}',
      headers: [],
    } as unknown as McpRequest;
    expect(() => injectMcpVariables(mcp, { next: '{{sec}}', sec: 'P' }, secretNames)).toThrow(
      /secret variable "sec"/
    );
    expect(injectString('{{sec}}', { next: '{{sec}}', sec: 'P' }, secretNames)).toBe('P');
    expect(() => injectString('{{next}}', { next: '{{sec}}', sec: 'P' }, secretNames)).toThrow(
      /secret variable "sec"/
    );
  });

  it('leaves the map walk as it was when no name is secret', () => {
    expect(injectString('{{a}}', { a: '{{b}}', b: 'v' })).toBe('v');
    expect(injectString('{{a}}', { b: 'v', a: '{{b}}' })).toBe('{{b}}');
    expect(injectString('{{ a }}', { a: 'v' })).toBe('{{ a }}');
  });
});

describe('load test', () => {
  it('sends nothing through a value and still sends a direct token', async () => {
    useEnvironment([plainRow, alias]);
    const signal = new AbortController().signal;
    await runLoadTest(
      request({ url: '{{next}}' }),
      { iterations: 1, concurrency: 1 },
      () => {},
      signal
    );
    expect(proxied).not.toHaveBeenCalled();
    await runLoadTest(
      request({ headers: [header('{{sec}}')] }),
      { iterations: 1, concurrency: 1 },
      () => {},
      signal
    );
    expect(proxied.mock.calls[0]?.[0].headers['X-Key']).toBe('PLAINTEXT');
  });
});

describe('GraphQL subscription handshake', () => {
  const input = (req: HttpRequest, desktop: boolean) => ({
    request: req,
    values: { next: '{{sec}}' },
    secretVariables: { sec: HANDLE },
    secretNames: ['sec'],
    resolveVariables: (text: string) => text,
    desktop,
  });

  it.each([true, false])('refuses through a value (desktop: %s)', (desktop) => {
    expect(() => buildSubscriptionHandshake(input(request({ url: '{{next}}' }), desktop))).toThrow(
      REFUSAL
    );
  });

  it('keeps a direct token for main', () => {
    const hs = buildSubscriptionHandshake(input(request({ headers: [header('{{sec}}')] }), true));
    expect(hs.headers['X-Key']).toBe('{{sec}}');
    expect(Object.keys(hs.mainSide?.secretVariables ?? {})).toEqual(['sec']);
  });
});

describe('the subscription auth notice renders', () => {
  it('reports a refused reference instead of throwing', () => {
    useEnvironment([handleRow, alias]);
    render(createElement(SubscriptionAuthNotice, { request: request({ url: '{{next}}' }) }));
    expect(screen.getByTestId('subscription-unapplied-auth').textContent).toMatch(REFUSAL);
  });

  it('reports a stored token pair that forms a reference', () => {
    useEnvironment([handleRow]);
    render(
      createElement(SubscriptionAuthNotice, {
        request: request({
          auth: { type: 'oauth2', oauth2: { accessToken: '}}', tokenType: '{{sec' } },
        }),
      })
    );
    expect(screen.getByTestId('subscription-unapplied-auth').textContent).toMatch(
      /form a variable reference/
    );
  });
});

describe('streaming sends are single pass', () => {
  it('leaves a token in a value literal, with no secret marked as used', () => {
    useEnvironment([plainRow, alias]);
    const scope = getActiveStreamingVariableScope();
    const viaValue = resolveStreamingText('{{next}}', scope);
    expect(viaValue.wire).toBe('https://other.test/?k={{sec}}');
    expect(viaValue.usedSecret).toBe(false);
    expect(resolveStreamingText('{{sec}}', scope).wire).toBe('PLAINTEXT');
  });
});
