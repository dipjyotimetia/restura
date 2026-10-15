/**
 * #882 — the desktop subscription path hands SecretRef handles to Electron
 * main as opaque refs: the WS IPC connect payload and the graphql-ws
 * `connection_init` frame must never contain credential plaintext, and the
 * handle descriptor must reach main for wire-time resolution.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest } from '@/types';
import { buildSubscriptionHandshake } from '../subscriptionAuth';
import { GraphQLSubscriptionClient } from '../subscriptionClient';

const PLAINTEXT = 'super-secret-plaintext';

interface CapturedConnect {
  connectionId: string;
  url: string;
  headers?: Record<string, string>;
  protocols?: string[];
  auth?: unknown;
  secretVariables?: unknown;
}

function installFakeElectron() {
  const handlers = new Map<string, (payload?: unknown) => void>();
  const connects: CapturedConnect[] = [];
  const sent: string[] = [];
  const websocket = {
    on: (ch: string, cb: (payload?: unknown) => void) => handlers.set(ch, cb),
    removeAllListeners: (ch: string) => void handlers.delete(ch),
    removeListener: (ch: string) => void handlers.delete(ch),
    connect: vi.fn(async (cfg: CapturedConnect) => {
      connects.push(cfg);
      // Complete the upgrade so graphql-ws sends connection_init.
      queueMicrotask(() =>
        handlers.get(`ws:open:${cfg.connectionId}`)?.({ protocol: 'graphql-transport-ws' })
      );
      return { success: true };
    }),
    send: vi.fn(async (cfg: { connectionId: string; message: string }) => {
      sent.push(cfg.message);
      return { success: true };
    }),
    disconnect: vi.fn(async () => ({ success: true })),
  };
  (window as unknown as { electron: unknown }).electron = { isElectron: true, websocket };
  return { connects, sent };
}

afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
});

const request: HttpRequest = {
  id: 'r',
  name: 'sub',
  type: 'http',
  method: 'POST',
  url: 'https://api.example.com/graphql',
  headers: [{ id: 'h', key: 'X-Secret', value: '{{apiSecret}}', enabled: true }],
  params: [],
  body: { type: 'graphql', raw: 'subscription { tick }' },
  auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'handle-1' } } },
};

describe('desktop subscription — handles never cross IPC as plaintext', () => {
  it('sends the handle descriptor + secret refs main-side; no plaintext in IPC or connection_init', async () => {
    const { connects, sent } = installFakeElectron();
    const handshake = buildSubscriptionHandshake({
      request,
      values: {},
      secretVariables: { apiSecret: { kind: 'handle', id: 'handle-2' } },
      // A renderer resolver that "knows" the plaintext must never be applied
      // to a secret-variable token.
      resolveVariables: (t) => t.replace('{{apiSecret}}', PLAINTEXT),
      desktop: true,
    });

    const client = new GraphQLSubscriptionClient(handshake.url, handshake.headers, {
      connectionParams: handshake.connectionParams,
      ...(handshake.mainSide ? { mainSide: handshake.mainSide } : {}),
    });
    client.connect({
      url: handshake.url,
      query: 'subscription { tick }',
      headers: handshake.headers,
      onMessage: () => {},
    });

    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    client.disconnect();

    expect(connects).toHaveLength(1);
    const connect = connects[0]!;
    expect(connect.url).toBe('wss://api.example.com/graphql');
    expect(connect.auth).toEqual({
      type: 'bearer',
      bearer: { token: { kind: 'handle', id: 'handle-1' } },
    });
    expect(connect.secretVariables).toEqual({ apiSecret: { kind: 'handle', id: 'handle-2' } });
    expect(connect.headers?.Authorization).toBeUndefined();
    expect(connect.headers?.['X-Secret']).toBe('{{apiSecret}}');

    const init = JSON.parse(sent[0]!) as { type: string; payload?: Record<string, string> };
    expect(init.type).toBe('connection_init');
    expect(init.payload?.Authorization).toBeUndefined();
    expect(init.payload?.['X-Secret']).toBeUndefined();

    expect(JSON.stringify(connects)).not.toContain(PLAINTEXT);
    expect(sent.join('')).not.toContain(PLAINTEXT);
  });

  it('omits auth/secretVariables from the IPC payload when nothing is main-side', async () => {
    const { connects } = installFakeElectron();
    const client = new GraphQLSubscriptionClient('https://api.example.com/graphql', {
      Authorization: 'Bearer inline',
    });
    client.connect({
      url: 'https://api.example.com/graphql',
      query: 'subscription { tick }',
      onMessage: () => {},
    });
    await vi.waitFor(() => expect(connects).toHaveLength(1));
    client.disconnect();
    expect(connects[0]).not.toHaveProperty('auth');
    expect(connects[0]).not.toHaveProperty('secretVariables');
    expect(connects[0]?.headers).toEqual({ Authorization: 'Bearer inline' });
  });
});
