import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { startMockWsServer, type MockWsServerHandle } from '../../../../../e2e/mocks/wsServer';
import { GraphQLSubscriptionClient, type SubscriptionMessage } from '../subscriptionClient';

// Drives the REAL ElectronGraphQLSocket bridge end-to-end. The Electron WS IPC
// API is faked, but backed by a real `ws` connection to the mock graphql-ws
// server — mirroring electron/main/websocket-handler.ts's relay. So the path is:
// graphql-ws client → bridge → (fake IPC) → real ws → mock graphql-ws server →
// Subscription.tick. This proves the graphql-transport-ws handshake (incl. the
// `socket.protocol` check) works over the IPC bridge, not just a primitive.

let server: MockWsServerHandle;

function installFakeElectronWsApi(): void {
  const sockets = new Map<string, WebSocket>();
  const handlers = new Map<string, (...a: unknown[]) => void>();
  const fire = (ch: string, payload?: unknown): void => handlers.get(ch)?.(payload);

  const websocket = {
    on: (ch: string, cb: (...a: unknown[]) => void) => handlers.set(ch, cb),
    removeAllListeners: (ch: string) => void handlers.delete(ch),
    removeListener: (ch: string) => void handlers.delete(ch),
    connect: async (cfg: { connectionId: string; url: string; protocols?: string[] }) => {
      const ws = new WebSocket(cfg.url, cfg.protocols ?? []);
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
  (window as unknown as { electron: unknown }).electron = { isElectron: true, websocket };
}

beforeAll(async () => {
  server = await startMockWsServer({ port: 0 });
});
afterAll(async () => {
  await server.close();
  delete (window as unknown as { electron?: unknown }).electron;
});

describe('GraphQL subscriptions over the Electron WS IPC bridge', () => {
  it('receives Subscription.tick frames and completes', async () => {
    installFakeElectronWsApi();
    const url = `${server.url}/graphql`; // ws://… already; subscriptionClient leaves it
    const messages: SubscriptionMessage[] = [];
    const client = new GraphQLSubscriptionClient(url, {});

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for subscription')), 8000);
      client.connect({
        url,
        query: 'subscription { tick(count: 3) { n timestamp } }',
        onMessage: (m) => {
          messages.push(m);
          if (m.type === 'complete') {
            clearTimeout(timer);
            resolve();
          }
        },
        onError: (e) => {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      });
    });

    client.disconnect();
    const data = messages.filter((m) => m.type === 'data');
    expect(data.length).toBe(3);
    expect(messages.some((m) => m.type === 'connected')).toBe(true);
    // Each frame carries the tick payload through the bridge intact.
    const first = data[0]?.payload as { data?: { tick?: { n?: number } } } | undefined;
    expect(first?.data?.tick?.n).toBeTypeOf('number');
  });
});
