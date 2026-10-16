import { SseStreamReader } from '@shared/protocol/sse-stream-reader';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  type GraphqlSseServerHandle,
  type LegacyGraphqlWsServerHandle,
  startGraphqlSseServer,
  startLegacyGraphqlWsServer,
} from '../../../../../e2e/mocks/graphqlSubscriptionServers';
import { type MockWsServerHandle, startMockWsServer } from '../../../../../e2e/mocks/wsServer';
import { GraphQLSubscriptionClient, type SubscriptionMessage } from '../subscriptionClient';

// Web graphql-sse streams through the Worker proxy; in tests the "proxy" is a
// direct fetch to the fixture so the real client parsing path is exercised.
const proxied = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock('@/lib/shared/transport', () => ({
  executeProxiedStreamingRequest: async (
    spec: { method: string; url: string; headers: Record<string, string>; data?: string },
    opts: { signal?: AbortSignal }
  ) => {
    proxied.calls.push(spec as unknown as Record<string, unknown>);
    return fetch(spec.url, {
      method: spec.method,
      headers: spec.headers,
      ...(spec.data !== undefined ? { body: spec.data } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  },
}));

// ---------------------------------------------------------------------------
// Fake Electron IPC bridge backed by real sockets — mirrors the relay done by
// electron/main/handlers/{websocket,sse}-handler.ts.
// ---------------------------------------------------------------------------

interface BridgeLog {
  wsConnects: Array<{ url: string; protocols?: string[]; headers?: Record<string, string> }>;
  sseConnects: Array<{ url: string; headers?: Record<string, string>; jsonBody?: string }>;
  sseDisconnects: string[];
}

function installFakeElectron(
  opts: { sseConnectResult?: { success: boolean; error?: string } } = {}
) {
  const log: BridgeLog = { wsConnects: [], sseConnects: [], sseDisconnects: [] };
  const sockets = new Map<string, WebSocket>();
  const sseAborts = new Map<string, AbortController>();
  const handlers = new Map<string, (...a: unknown[]) => void>();
  const fire = (ch: string, payload?: unknown): void => handlers.get(ch)?.(payload);
  const listeners = {
    on: (ch: string, cb: (...a: unknown[]) => void) => handlers.set(ch, cb),
    removeAllListeners: (ch: string) => void handlers.delete(ch),
    removeListener: (ch: string) => void handlers.delete(ch),
  };

  const websocket = {
    ...listeners,
    connect: async (cfg: {
      connectionId: string;
      url: string;
      protocols?: string[];
      headers?: Record<string, string>;
    }) => {
      log.wsConnects.push({ url: cfg.url, protocols: cfg.protocols, headers: cfg.headers });
      const ws = new WebSocket(cfg.url, cfg.protocols ?? [], { headers: cfg.headers ?? {} });
      sockets.set(cfg.connectionId, ws);
      ws.on('open', () => fire(`ws:open:${cfg.connectionId}`, { protocol: ws.protocol }));
      ws.on('message', (d: Buffer) =>
        fire(`ws:message:${cfg.connectionId}`, { type: 'text', data: d.toString() })
      );
      ws.on('error', (e: Error) => fire(`ws:error:${cfg.connectionId}`, { message: e.message }));
      ws.on('close', (code: number, reason: Buffer) =>
        fire(`ws:close:${cfg.connectionId}`, { code, reason: reason.toString() })
      );
      return { success: true };
    },
    send: async (cfg: { connectionId: string; message: string }) => {
      sockets.get(cfg.connectionId)?.send(cfg.message);
      return { success: true };
    },
    disconnect: async (cfg: { connectionId: string }) => {
      sockets.get(cfg.connectionId)?.close();
      sockets.delete(cfg.connectionId);
      return { success: true };
    },
  };

  const sse = {
    ...listeners,
    connect: async (cfg: {
      connectionId: string;
      url: string;
      headers?: Record<string, string>;
      jsonBody?: string;
    }) => {
      log.sseConnects.push({ url: cfg.url, headers: cfg.headers, jsonBody: cfg.jsonBody });
      if (opts.sseConnectResult) return opts.sseConnectResult;
      const ac = new AbortController();
      sseAborts.set(cfg.connectionId, ac);
      const res = await fetch(cfg.url, {
        method: cfg.jsonBody !== undefined ? 'POST' : 'GET',
        headers: { Accept: 'text/event-stream', ...(cfg.headers ?? {}) },
        ...(cfg.jsonBody !== undefined ? { body: cfg.jsonBody } : {}),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const message = `HTTP ${res.status} ${res.statusText}`;
        fire(`sse:error:${cfg.connectionId}`, { message });
        fire(`sse:close:${cfg.connectionId}`, { reason: message });
        return { success: false, error: message };
      }
      fire(`sse:open:${cfg.connectionId}`);
      void (async () => {
        const reader = res.body!.getReader();
        const parser = new SseStreamReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.feed(decoder.decode(value, { stream: true }), (e) =>
              fire(`sse:event:${cfg.connectionId}`, e)
            );
          }
          fire(`sse:close:${cfg.connectionId}`, { reason: 'stream ended' });
        } catch {
          /* aborted */
        }
      })();
      return { success: true };
    },
    disconnect: async (cfg: { connectionId: string }) => {
      log.sseDisconnects.push(cfg.connectionId);
      sseAborts.get(cfg.connectionId)?.abort();
      return { success: true };
    },
  };

  (window as unknown as { electron: unknown }).electron = { isElectron: true, websocket, sse };
  return { log, fire };
}

function uninstallFakeElectron(): void {
  delete (window as unknown as { electron?: unknown }).electron;
}

type Opts = Partial<Parameters<GraphQLSubscriptionClient['connect']>[0]>;

/** Run one subscription to its terminal event; resolves with every message. */
function run(
  url: string,
  options: Opts,
  headers: Record<string, string> = {}
): Promise<SubscriptionMessage[]> {
  const messages: SubscriptionMessage[] = [];
  const client = new GraphQLSubscriptionClient(url, headers);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.disconnect();
      reject(new Error(`timeout: ${JSON.stringify(messages)}`));
    }, 8000);
    const done = () => {
      clearTimeout(timer);
      resolve(messages);
    };
    client.connect({
      url,
      query: 'subscription Ticks { tick(count: 3) { n } }',
      ...options,
      onMessage: (m) => {
        messages.push(m);
        if (m.type === 'complete' || m.type === 'error') done();
      },
    });
  });
}

const dataOf = (msgs: SubscriptionMessage[]) => msgs.filter((m) => m.type === 'data');
const connectedProtocol = (msgs: SubscriptionMessage[]) =>
  msgs.find((m) => m.type === 'connected')?.protocol;

let legacy: LegacyGraphqlWsServerHandle;
let modern: MockWsServerHandle;
let sseServer: GraphqlSseServerHandle;

beforeAll(async () => {
  [legacy, modern, sseServer] = await Promise.all([
    startLegacyGraphqlWsServer(),
    startMockWsServer({ port: 0 }),
    startGraphqlSseServer(),
  ]);
});
afterAll(async () => {
  await Promise.all([legacy.close(), modern.close(), sseServer.close()]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  uninstallFakeElectron();
  proxied.calls.length = 0;
});

describe('subscriptions-transport-ws (legacy Apollo) client', () => {
  it('streams data and completes over the desktop IPC bridge', async () => {
    const { log } = installFakeElectron();
    const msgs = await run(
      legacy.url,
      { protocol: 'subscriptions-transport-ws', operationName: 'Ticks', variables: { a: 1 } },
      { Authorization: 'Bearer t' }
    );
    expect(msgs.at(-1)?.type).toBe('complete');
    expect(
      dataOf(msgs).map((m) => (m.payload as { data: { tick: { n: number } } }).data.tick.n)
    ).toEqual([0, 1, 2]);
    expect(connectedProtocol(msgs)).toBe('graphql-ws');
    // The chosen subprotocol + handshake headers ride the IPC connect call.
    expect(log.wsConnects[0]).toMatchObject({
      protocols: ['graphql-ws'],
      headers: { Authorization: 'Bearer t' },
    });
    const sent = legacy.received();
    expect(sent.find((m) => m.type === 'connection_init')?.payload).toEqual({
      Authorization: 'Bearer t',
    });
    expect(sent.find((m) => m.type === 'start')?.payload).toEqual({
      query: 'subscription Ticks { tick(count: 3) { n } }',
      variables: { a: 1 },
      operationName: 'Ticks',
    });
  });

  it('works with the browser WebSocket on web', async () => {
    // jsdom's global WebSocket (undici) can't dispatch under jsdom; `ws` speaks the same API.
    vi.stubGlobal('WebSocket', WebSocket);
    const msgs = await run(legacy.url, { protocol: 'subscriptions-transport-ws' });
    expect(dataOf(msgs)).toHaveLength(3);
    expect(msgs.at(-1)?.type).toBe('complete');
    expect(legacy.lastProtocol()).toBe('graphql-ws');
  });

  it('accepts an http(s) URL and converts it to ws(s)', async () => {
    installFakeElectron();
    const msgs = await run(legacy.url.replace(/^ws:/, 'http:'), {
      protocol: 'subscriptions-transport-ws',
    });
    expect(dataOf(msgs)).toHaveLength(3);
  });

  it('reports operation errors from the server', async () => {
    installFakeElectron();
    const msgs = await run(legacy.url, {
      protocol: 'subscriptions-transport-ws',
      query: 'subscription { nope }',
    });
    expect(msgs.at(-1)?.type).toBe('error');
    expect(msgs.at(-1)?.error).toMatch(/nope/);
  });

  it('reports connection_error and stops', async () => {
    const rejecting = await startLegacyGraphqlWsServer({ rejectInit: true });
    try {
      installFakeElectron();
      const msgs = await run(rejecting.url, { protocol: 'subscriptions-transport-ws' });
      expect(msgs.at(-1)).toMatchObject({ type: 'error', error: 'Forbidden' });
    } finally {
      await rejecting.close();
    }
  });

  it('sends stop + connection_terminate when disconnected mid-subscription', async () => {
    installFakeElectron();
    const client = new GraphQLSubscriptionClient(legacy.url, {});
    await new Promise<void>((resolve) => {
      client.connect({
        url: legacy.url,
        query: 'subscription { tick(count: 10) { n } }',
        protocol: 'subscriptions-transport-ws',
        onMessage: (m) => {
          if (m.type === 'connected') resolve();
        },
      });
    });
    expect(client.isConnected).toBe(true);
    client.disconnect();
    expect(client.isConnected).toBe(false);
    await vi.waitFor(() => {
      const types = legacy.received().map((m) => m.type);
      expect(types).toContain('stop');
      expect(types).toContain('connection_terminate');
    });
  });
});

describe('auto subprotocol negotiation', () => {
  it('offers both subprotocols and dispatches to the legacy client when the server picks graphql-ws', async () => {
    const { log } = installFakeElectron();
    const msgs = await run(legacy.url, { protocol: 'auto' });
    expect(log.wsConnects).toHaveLength(1);
    expect(log.wsConnects[0]?.protocols).toEqual(['graphql-transport-ws', 'graphql-ws']);
    expect(connectedProtocol(msgs)).toBe('graphql-ws');
    expect(dataOf(msgs)).toHaveLength(3);
    expect(msgs.at(-1)?.type).toBe('complete');
  });

  it('adopts the negotiated socket for graphql-transport-ws (single handshake)', async () => {
    const { log } = installFakeElectron();
    modern.reset();
    const msgs = await run(`${modern.url}/graphql`, { operationName: 'Ticks' });
    expect(log.wsConnects).toHaveLength(1);
    expect(connectedProtocol(msgs)).toBe('graphql-transport-ws');
    expect(dataOf(msgs)).toHaveLength(3);
    expect(modern.graphqlSubscribePayloads()[0]).toMatchObject({ operationName: 'Ticks' });
  });

  it('works on web with the browser WebSocket', async () => {
    vi.stubGlobal('WebSocket', WebSocket);
    const msgs = await run(legacy.url, {});
    expect(connectedProtocol(msgs)).toBe('graphql-ws');
    expect(dataOf(msgs)).toHaveLength(3);
  });

  it('falls back to legacy when a first-offered server accepts graphql-transport-ws then closes 1002', async () => {
    const naive = await startLegacyGraphqlWsServer({ acceptFirstOffered: true });
    try {
      const { log } = installFakeElectron();
      const msgs = await run(naive.url, { operationName: 'Ticks' });
      expect(log.wsConnects.map((c) => c.protocols)).toEqual([
        ['graphql-transport-ws', 'graphql-ws'],
        ['graphql-ws'],
      ]);
      expect(connectedProtocol(msgs)).toBe('graphql-ws');
      expect(dataOf(msgs)).toHaveLength(3);
      expect(msgs.filter((m) => m.type === 'error')).toEqual([]);
      expect(msgs.at(-1)?.type).toBe('complete');
    } finally {
      await naive.close();
    }
  });

  it('falls back to legacy on web too', async () => {
    vi.stubGlobal('WebSocket', WebSocket);
    const naive = await startLegacyGraphqlWsServer({ acceptFirstOffered: true });
    try {
      const msgs = await run(naive.url, {});
      expect(connectedProtocol(msgs)).toBe('graphql-ws');
      expect(dataOf(msgs)).toHaveLength(3);
    } finally {
      await naive.close();
    }
  });

  it('reports a failed handshake', async () => {
    installFakeElectron();
    // The plain mock server rejects unknown subprotocol offers on non-graphql paths.
    const msgs = await run(`${modern.url}/echo`, {});
    expect(msgs.at(-1)?.type).toBe('error');
  });

  it('can be cancelled while negotiating', () => {
    installFakeElectron();
    const client = new GraphQLSubscriptionClient(legacy.url, {});
    const seen: SubscriptionMessage[] = [];
    client.connect({
      url: legacy.url,
      query: 'subscription { tick { n } }',
      onMessage: (m) => seen.push(m),
    });
    expect(client.isConnected).toBe(true);
    client.disconnect();
    expect(client.isConnected).toBe(false);
    expect(seen.map((m) => m.type)).toEqual(['connecting']);
  });
});

describe('graphql-transport-ws (explicit)', () => {
  it('passes operationName and reports the negotiated protocol', async () => {
    installFakeElectron();
    modern.reset();
    const msgs = await run(`${modern.url}/graphql`, {
      protocol: 'graphql-transport-ws',
      operationName: 'Ticks',
    });
    expect(connectedProtocol(msgs)).toBe('graphql-transport-ws');
    expect(dataOf(msgs)).toHaveLength(3);
    expect(modern.graphqlSubscribePayloads()[0]).toMatchObject({ operationName: 'Ticks' });
  });
});

describe('graphql-sse client (distinct connections)', () => {
  it('POSTs the operation through the desktop SSE IPC handler', async () => {
    const { log } = installFakeElectron();
    const msgs = await run(
      sseServer.url,
      { protocol: 'graphql-sse', operationName: 'Ticks' },
      { Authorization: 'Bearer s' }
    );
    expect(connectedProtocol(msgs)).toBe('graphql-sse');
    expect(
      dataOf(msgs).map((m) => (m.payload as { data: { tick: { n: number } } }).data.tick.n)
    ).toEqual([0, 1, 2]);
    expect(msgs.at(-1)?.type).toBe('complete');
    expect(log.sseConnects[0]).toMatchObject({
      url: sseServer.url,
      headers: { Authorization: 'Bearer s', 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(log.sseConnects[0]?.jsonBody ?? '{}')).toEqual({
      query: 'subscription Ticks { tick(count: 3) { n } }',
      operationName: 'Ticks',
    });
    const req = sseServer.requests().at(-1);
    expect(req?.method).toBe('POST');
    expect(req?.headers.authorization).toBe('Bearer s');
  });

  it('streams through the Worker proxy on web', async () => {
    const msgs = await run(sseServer.url.replace(/^http:/, 'ws:'), {
      protocol: 'graphql-sse',
      variables: { x: 1 },
    });
    expect(dataOf(msgs)).toHaveLength(3);
    expect(msgs.at(-1)?.type).toBe('complete');
    expect(proxied.calls[0]).toMatchObject({
      method: 'POST',
      url: sseServer.url,
      bodyType: 'json',
      streamingMode: true,
    });
  });

  it('surfaces HTTP errors on web', async () => {
    const msgs = await run(sseServer.url.replace('/graphql/stream', '/nope'), {
      protocol: 'graphql-sse',
    });
    expect(msgs.at(-1)).toMatchObject({ type: 'error', error: 'HTTP 405 Method Not Allowed' });
  });

  it('surfaces HTTP errors on desktop', async () => {
    installFakeElectron();
    const msgs = await run(sseServer.url.replace('/graphql/stream', '/nope'), {
      protocol: 'graphql-sse',
    });
    expect(msgs.at(-1)).toMatchObject({ type: 'error', error: 'HTTP 405 Method Not Allowed' });
  });

  it('surfaces an IPC connect rejection on desktop', async () => {
    installFakeElectron({
      sseConnectResult: { success: false, error: 'URL rejected by SSRF policy' },
    });
    const msgs = await run(sseServer.url, { protocol: 'graphql-sse' });
    expect(msgs.at(-1)).toMatchObject({ type: 'error', error: 'URL rejected by SSRF policy' });
  });

  it('disconnects the IPC stream when cancelled', async () => {
    const { log } = installFakeElectron();
    const client = new GraphQLSubscriptionClient(sseServer.url, {});
    await new Promise<void>((resolve) => {
      client.connect({
        url: sseServer.url,
        query: 'subscription { tick(count: 10) { n } }',
        protocol: 'graphql-sse',
        onMessage: (m) => {
          if (m.type === 'data') resolve();
        },
      });
    });
    client.disconnect();
    expect(log.sseDisconnects.length).toBeGreaterThanOrEqual(1);
  });
});

// The builder passes the picker's selection straight through: a name for the
// selected operation of a multi-operation document, `null` for an anonymous one.
describe('operation picker selection on every protocol (#903)', () => {
  const MULTI = 'query Q { __typename }\nsubscription Ticks { tick(count: 3) { n } }';

  it('graphql-transport-ws runs the selected operation of a multi-operation document', async () => {
    installFakeElectron();
    modern.reset();
    const msgs = await run(`${modern.url}/graphql`, {
      protocol: 'graphql-transport-ws',
      query: MULTI,
      operationName: 'Ticks',
    });
    expect(dataOf(msgs)).toHaveLength(3);
    expect(modern.graphqlSubscribePayloads()[0]).toMatchObject({
      query: MULTI,
      operationName: 'Ticks',
    });
  });

  it('subscriptions-transport-ws sends the selection and omits a null name', async () => {
    installFakeElectron();
    await run(legacy.url, {
      protocol: 'subscriptions-transport-ws',
      query: MULTI,
      operationName: 'Ticks',
    });
    const starts = () => legacy.received().filter((m) => m.type === 'start');
    expect(starts().at(-1)?.payload).toMatchObject({ query: MULTI, operationName: 'Ticks' });

    await run(legacy.url, { protocol: 'subscriptions-transport-ws', operationName: null });
    expect(starts().at(-1)?.payload).not.toHaveProperty('operationName');
  });

  it('graphql-sse sends the selection and omits a null name', async () => {
    const { log } = installFakeElectron();
    await run(sseServer.url, { protocol: 'graphql-sse', query: MULTI, operationName: 'Ticks' });
    expect(JSON.parse(log.sseConnects.at(-1)?.jsonBody ?? '{}')).toEqual({
      query: MULTI,
      operationName: 'Ticks',
    });

    await run(sseServer.url, { protocol: 'graphql-sse', operationName: null });
    expect(JSON.parse(log.sseConnects.at(-1)?.jsonBody ?? '{}')).not.toHaveProperty(
      'operationName'
    );
  });
});
