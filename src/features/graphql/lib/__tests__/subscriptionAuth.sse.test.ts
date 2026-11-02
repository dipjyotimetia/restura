/**
 * #878 / #882 parity for graphql-sse: the same effective handshake (inherited,
 * {{vars}}-resolved auth, query API key) applies, desktop forwards SecretRef
 * refs to `sse:connect` for main-side resolution (never plaintext), and web
 * sends the renderer-resolved headers/URL through the Worker proxy.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest } from '@/types';

const proxyMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shared/transport', () => ({
  executeProxiedStreamingRequest: (...args: unknown[]) => proxyMock(...args),
}));

import { buildSubscriptionHandshake } from '../subscriptionAuth';
import { GraphQLSubscriptionClient } from '../subscriptionClient';

const PLAINTEXT = 'sse-plaintext-never-in-renderer';

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id: 'r',
    name: 'sub',
    type: 'http',
    method: 'POST',
    url: 'https://api.example.com/graphql/stream',
    headers: [{ id: 'h', key: 'X-Tenant', value: '{{tenant}}', enabled: true }],
    params: [],
    body: { type: 'graphql', raw: 'subscription { tick }' },
    auth: { type: 'none' },
    ...overrides,
  };
}

function subscribe(hs: ReturnType<typeof buildSubscriptionHandshake>) {
  const client = new GraphQLSubscriptionClient(hs.url, hs.headers, {
    connectionParams: hs.connectionParams,
    ...(hs.mainSide ? { mainSide: hs.mainSide } : {}),
    stripOnOriginChange: hs.stripOnOriginChange,
  });
  client.connect({
    url: hs.url,
    query: 'subscription { tick }',
    headers: hs.headers,
    protocol: 'graphql-sse',
    onMessage: () => {},
  });
  return client;
}

afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
  proxyMock.mockReset();
});

describe('graphql-sse subscription auth', () => {
  it('desktop: forwards handle auth + secret refs to sse:connect, no plaintext', async () => {
    const connect = vi.fn(async (_cfg: Record<string, unknown>) => ({ success: true }));
    (window as unknown as { electron: unknown }).electron = {
      isElectron: true,
      sse: {
        connect,
        disconnect: vi.fn(async () => ({ success: true })),
        on: vi.fn(),
        removeAllListeners: vi.fn(),
      },
    };
    const auth = {
      type: 'api-key',
      apiKey: { key: 'api_key', value: { kind: 'handle', id: 'h-1' }, in: 'query' },
    } as const;
    const hs = buildSubscriptionHandshake({
      request: request({
        headers: [{ id: 'h', key: 'X-Secret', value: '{{s}}', enabled: true }],
        auth,
      }),
      values: {},
      secretVariables: { s: { kind: 'handle', id: 'h-2' } },
      resolveVariables: (t) => t.replace('{{s}}', PLAINTEXT),
      desktop: true,
    });
    const client = subscribe(hs);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    client.disconnect();

    const cfg = connect.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(cfg.url).toBe('https://api.example.com/graphql/stream');
    expect(cfg.auth).toEqual(auth);
    expect(cfg.secretVariables).toEqual({ s: { kind: 'handle', id: 'h-2' } });
    expect((cfg.headers as Record<string, string>)['X-Secret']).toBe('{{s}}');
    expect(typeof cfg.jsonBody).toBe('string');
    expect(JSON.stringify(cfg)).not.toContain(PLAINTEXT);
  });

  it.each([
    ['web', false],
    ['desktop', true],
  ])('%s: names an API key header for redirects', async (_name, desktop) => {
    const connect = vi.fn(async (_cfg: Record<string, unknown>) => ({ success: true }));
    if (desktop) {
      (window as unknown as { electron: unknown }).electron = {
        isElectron: true,
        sse: {
          connect,
          disconnect: vi.fn(async () => ({ success: true })),
          on: vi.fn(),
          removeAllListeners: vi.fn(),
        },
      };
    }
    proxyMock.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
    const hs = buildSubscriptionHandshake({
      request: request({
        auth: { type: 'api-key', apiKey: { key: 'X-Unusual', value: 'k', in: 'header' } },
      }),
      values: {},
      secretVariables: {},
      resolveVariables: (t) => t,
      desktop,
    });
    expect(hs.stripOnOriginChange).toEqual(['X-Unusual']);
    const client = subscribe(hs);
    if (desktop) {
      await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
      expect(connect.mock.calls[0]?.[0]).toMatchObject({ stripOnOriginChange: ['X-Unusual'] });
    } else {
      await vi.waitFor(() => expect(proxyMock).toHaveBeenCalledTimes(1));
      expect(proxyMock.mock.calls[0]?.[0]).toMatchObject({
        redirectPolicy: { stripOnOriginChange: ['X-Unusual'] },
      });
    }
    client.disconnect();
  });

  it('web: sends resolved headers + inherited auth + query API key through the proxy', async () => {
    proxyMock.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
    const hs = buildSubscriptionHandshake({
      request: request(),
      inheritedAuth: {
        type: 'api-key',
        apiKey: { key: 'api_key', value: '{{token}}', in: 'query' },
      },
      values: { tenant: 'acme', token: 'tok-1' },
      secretVariables: {},
      resolveVariables: (t) => t,
      desktop: false,
    });
    const client = subscribe(hs);
    await vi.waitFor(() => expect(proxyMock).toHaveBeenCalledTimes(1));
    client.disconnect();

    const spec = proxyMock.mock.calls[0]?.[0] as {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    expect(spec.method).toBe('POST');
    expect(spec.url).toBe('https://api.example.com/graphql/stream?api_key=tok-1');
    expect(spec.headers['X-Tenant']).toBe('acme');
    expect(spec).not.toHaveProperty('auth');
  });

  it('web: a handle-backed bearer is unapplied (never sent as a placeholder)', async () => {
    proxyMock.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
    const hs = buildSubscriptionHandshake({
      request: request({
        auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'h' } } },
      }),
      values: { tenant: 'acme' },
      secretVariables: {},
      resolveVariables: (t) => t,
      desktop: false,
    });
    expect(hs.unapplied).toEqual([expect.stringMatching(/desktop app/)]);
    const client = subscribe(hs);
    await vi.waitFor(() => expect(proxyMock).toHaveBeenCalledTimes(1));
    client.disconnect();
    const spec = proxyMock.mock.calls[0]?.[0] as { headers: Record<string, string> };
    expect(spec.headers.Authorization).toBeUndefined();
  });
});
