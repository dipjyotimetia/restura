// @vitest-environment node

import { Buffer } from 'node:buffer';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { WSContext, type WSEvents } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { Env } from '../../env';
import { createNodeWebsocketHandler } from '../websocket-node';
import { wsTicket } from '../ws-ticket';

// The DNS guard is not the seam under test (the relay is); stub it so a test
// can hold the handler inside its `await` or make it fail with a given error.
const dns = vi.hoisted(() => ({ assertNodeHostnameSafe: vi.fn() }));
vi.mock('../../shared/dns-guard-node', () => dns);

const DEV_ENV: Env = { ENVIRONMENT: 'development', DEV_BYPASS_AUTH: 'true' };

/** Mirror of `ws` Sender.close validation (node_modules/ws/lib/sender.js). */
function assertSendableClose(code?: number, reason?: string): void {
  if (code !== undefined) {
    const ok =
      (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
      (code >= 3000 && code <= 4999);
    if (!ok) throw new TypeError('First argument must be a valid error code number');
  }
  if (reason !== undefined && Buffer.byteLength(reason) > 123) {
    throw new RangeError('The message must not be greater than 123 bytes');
  }
}

/** Client-side WSContext whose close() rejects what the real `ws` server socket rejects. */
function fakeClient() {
  const closes: Array<{ code: number | undefined; reason: string | undefined }> = [];
  const ws = new WSContext({
    send: () => undefined,
    close(code, reason) {
      assertSendableClose(code, reason);
      closes.push({ code, reason });
    },
    readyState: 1,
  });
  return { ws, closes };
}

let server: WebSocketServer;
let upstreamUrl: string;
const upstreamSockets: WsSocket[] = [];

beforeEach(async () => {
  dns.assertNodeHostnameSafe.mockReset();
  dns.assertNodeHostnameSafe.mockResolvedValue(undefined);
  upstreamSockets.length = 0;
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (s) => upstreamSockets.push(s));
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  upstreamUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterEach(async () => {
  for (const s of upstreamSockets) s.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Mint a ticket and run createEvents through a real Hono context. */
async function openEvents(): Promise<WSEvents> {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/api/ws-ticket', wsTicket);
  let events: WSEvents | undefined;
  app.get(
    '/api/ws',
    createNodeWebsocketHandler((createEvents) => async (c) => {
      events = await createEvents(c);
      return c.text('ok');
    })
  );
  const minted = await app.request(
    '/api/ws-ticket',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: upstreamUrl }),
    },
    DEV_ENV
  );
  const { ticket } = (await minted.json()) as { ticket: string };
  await app.request(`/api/ws?ticket=${ticket}`, {}, DEV_ENV);
  if (!events) throw new Error('createEvents did not run');
  return events;
}

const until = (cond: () => boolean) =>
  vi.waitFor(() => expect(cond()).toBe(true), { timeout: 1000 });

describe('Node WebSocket relay — close codes that cannot be sent', () => {
  it('closes the client with 1000 when the upstream closes without a status (1005)', async () => {
    const events = await openEvents();
    const client = fakeClient();
    await events.onOpen?.(new Event('open'), client.ws);
    await until(() => upstreamSockets.length === 1);
    upstreamSockets[0]?.close(); // no code → the receiving side sees 1005
    await until(() => client.closes.length > 0);
    expect(client.closes[0]?.code).toBe(1000);
  });

  it('closes the upstream when the client goes away abnormally (1006)', async () => {
    const events = await openEvents();
    const client = fakeClient();
    await events.onOpen?.(new Event('open'), client.ws);
    await until(() => upstreamSockets.length === 1);
    const upstreamClosed = new Promise<number>((resolve) =>
      upstreamSockets[0]?.once('close', (code) => resolve(code))
    );
    events.onClose?.(new CloseEvent('close', { code: 1006, reason: '' }), client.ws);
    await expect(upstreamClosed).resolves.toBe(1011);
  });
});

describe('Node WebSocket relay — close reasons and onOpen failures', () => {
  it('truncates an over-long error into a valid close reason instead of rejecting onOpen', async () => {
    dns.assertNodeHostnameSafe.mockRejectedValue(new Error(`blocked ${'é'.repeat(200)}`));
    const events = await openEvents();
    const client = fakeClient();
    await expect(events.onOpen?.(new Event('open'), client.ws)).resolves.toBeUndefined();
    expect(client.closes).toHaveLength(1);
    expect(client.closes[0]?.code).toBe(1008);
    const reason = client.closes[0]?.reason ?? '';
    expect(reason.startsWith('Upstream DNS guard failed: blocked é')).toBe(true);
    expect(Buffer.byteLength(reason)).toBeLessThanOrEqual(123);
  });
});

describe('Node WebSocket relay — client gone or flooding before the upstream is dialled', () => {
  it('does not dial the upstream when the client closed during the DNS check', async () => {
    let release: () => void = () => undefined;
    dns.assertNodeHostnameSafe.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const events = await openEvents();
    const client = fakeClient();
    const opening = events.onOpen?.(new Event('open'), client.ws);
    events.onClose?.(new CloseEvent('close', { code: 1001, reason: '' }), client.ws);
    release();
    await opening;
    await new Promise((r) => setTimeout(r, 100));
    expect(upstreamSockets).toHaveLength(0);
  });

  it('closes with 1013 once the pre-open queue exceeds its byte cap', async () => {
    dns.assertNodeHostnameSafe.mockReturnValue(new Promise<void>(() => undefined));
    const events = await openEvents();
    const client = fakeClient();
    void events.onOpen?.(new Event('open'), client.ws);
    const frame = 'a'.repeat(1024 * 1024);
    for (let i = 0; i < 5; i++) {
      events.onMessage?.(new MessageEvent('message', { data: frame }), client.ws);
    }
    expect(client.closes.map((c) => c.code)).toContain(1013);
  });
});
