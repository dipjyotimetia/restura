// @vitest-environment node

import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../env';
import { closeReason, relayCloseCode } from '../../shared/ws-relay';
import { websocketHandler } from '../websocket';
import { wsTicket } from '../ws-ticket';

const BYTES = (s: string) => new TextEncoder().encode(s).byteLength;

describe('relayCloseCode', () => {
  it('passes through codes an endpoint may send', () => {
    for (const code of [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1011, 1013, 1014, 3000, 4999]) {
      expect(relayCloseCode(code)).toBe(code);
    }
  });

  it('maps reserved / received-only codes to 1000', () => {
    for (const code of [0, 999, 1004, 1005, 1006, 1015, 1016, 2999, 5000]) {
      expect(relayCloseCode(code)).toBe(1000);
    }
  });
});

describe('closeReason', () => {
  it('keeps a short reason unchanged', () => {
    expect(closeReason('Frame too large')).toBe('Frame too large');
  });

  it('truncates ASCII to 123 bytes', () => {
    expect(closeReason('x'.repeat(500))).toBe('x'.repeat(123));
  });

  it('never splits a multi-byte character', () => {
    const out = closeReason('€'.repeat(100)); // 3 bytes each
    expect(out).toBe('€'.repeat(41));
    expect(BYTES(out)).toBe(123);
  });

  it('never splits a surrogate pair', () => {
    const out = closeReason(`a${'😀'.repeat(60)}`); // 1 + 4 bytes each
    expect(out).toBe(`a${'😀'.repeat(30)}`);
    expect(BYTES(out)).toBe(121);
  });

  it('counts a lone surrogate as its 3-byte replacement character', () => {
    const out = closeReason('\ud800'.repeat(60));
    expect(BYTES(out)).toBeLessThanOrEqual(123);
    expect(out.length).toBe(41);
  });
});

// ---------------------------------------------------------------------------
// Cloudflare relay wiring: a fake WebSocketPair / upgraded fetch whose close()
// rejects what workerd rejects (reserved codes, reasons over 123 bytes).

type Listener = (ev: unknown) => void;

/** workerd's WebSocket.close() code check, written out independently of the code under test. */
const isSendableCloseCode = (code: number): boolean =>
  (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
  (code >= 3000 && code <= 4999);

class FakeCfSocket {
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }> = [];
  private readonly listeners = new Map<string, Listener[]>();
  accept(): void {}
  send(): void {}
  close(code?: number, reason?: string): void {
    if (code !== undefined && !isSendableCloseCode(code)) {
      throw new TypeError(`Invalid WebSocket close code: ${code}.`);
    }
    if (reason !== undefined && BYTES(reason) > 123) throw new RangeError('reason too long');
    this.closes.push({ code, reason });
  }
  addEventListener(type: string, cb: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  fire(type: string, ev: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function relay(): Promise<{ server: FakeCfSocket; upstream: FakeCfSocket }> {
  const client = new FakeCfSocket();
  const server = new FakeCfSocket();
  const upstream = new FakeCfSocket();
  vi.stubGlobal(
    'WebSocketPair',
    class {
      0 = client;
      1 = server;
    }
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ webSocket: upstream }))
  );
  const env: Env = { ENVIRONMENT: 'development', DEV_BYPASS_AUTH: 'true' };
  const app = new Hono<{ Bindings: Env }>();
  app.post('/api/ws-ticket', wsTicket);
  app.get('/api/ws', websocketHandler);
  const minted = await app.request(
    '/api/ws-ticket',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'wss://echo.example/ws' }),
    },
    env
  );
  const { ticket } = (await minted.json()) as { ticket: string };
  // Node's Response rejects status 101 (workerd allows it), so the request
  // itself errors after the relay is wired; the pipes are what we exercise.
  await app.request(`/api/ws?ticket=${ticket}`, { headers: { Upgrade: 'websocket' } }, env);
  return { server, upstream };
}

describe('Cloudflare WebSocket relay — close forwarding', () => {
  it('forwards an upstream 1006 to the client as 1000 instead of throwing', async () => {
    const { server, upstream } = await relay();
    upstream.fire('close', { code: 1006, reason: '' });
    expect(server.closes).toEqual([{ code: 1000, reason: '' }]);
  });

  it('forwards a client 1005 to the upstream as 1000 instead of throwing', async () => {
    const { server, upstream } = await relay();
    server.fire('close', { code: 1005, reason: '' });
    expect(upstream.closes).toEqual([{ code: 1000, reason: '' }]);
  });
});
