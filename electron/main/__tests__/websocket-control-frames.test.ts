// @vitest-environment node
//
// Control-frame surface of the desktop WebSocket handler: custom close
// code/reason (#915), ws:ping + ping/pong forwarding with RTT (#919), and the
// negotiated subprotocol/extensions + permessage-deflate toggle (#923).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());

const wsMock = vi.hoisted(() => {
  class FakeWebSocket {
    static OPEN = 1;
    static instances: FakeWebSocket[] = [];
    readyState = 1;
    protocol = '';
    extensions = '';
    options: Record<string, unknown> | undefined;
    send = vi.fn();
    close = vi.fn();
    // Like `ws`: the optional callback reports the frame write result.
    ping = vi.fn((_data?: unknown, _mask?: boolean, cb?: (err?: Error) => void) => cb?.());
    terminate = vi.fn();
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor(_url: string, _protocols?: unknown, options?: Record<string, unknown>) {
      this.options = options;
      FakeWebSocket.instances.push(this);
    }
    on(evt: string, cb: (...args: unknown[]) => void): this {
      const arr = this.listeners.get(evt) ?? [];
      arr.push(cb);
      this.listeners.set(evt, arr);
      return this;
    }
    fire(evt: string, ...args: unknown[]): void {
      for (const cb of this.listeners.get(evt) ?? []) cb(...args);
    }
  }
  return { FakeWebSocket };
});

vi.mock('electron', () => ({ ipcMain: { handle: mockHandle, removeHandler: vi.fn() } }));
vi.mock('ws', () => ({ default: wsMock.FakeWebSocket }));
vi.mock('../ipc/ipc-utils', () => ({ emitTo: mockEmitTo }));
// Keychain stand-in so a main-side-auth connect exercises the redactor.
vi.mock('../security/secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown): string | undefined => {
    const ref = v as { kind?: string; id?: string } | undefined;
    return ref?.kind === 'handle' && ref.id === 'h-token' ? 'keychain-token' : undefined;
  },
}));
vi.mock('../security/safe-connect', () => ({
  resolveSafeAddress: vi.fn(async () => ({
    host: 'echo.example.com',
    ip: '203.0.113.1',
    port: 443,
    family: 4 as const,
  })),
  createPinnedLookup: () => vi.fn(),
}));

import { IPC } from '../../shared/channels';
import { registerWebSocketHandlerIPC, stopWebSocketCleanup } from '../handlers/websocket-handler';
import { setExecutionPolicy } from '../security/execution-policy';

type IpcHandler = (e: unknown, p: unknown) => Promise<{ success: boolean; error?: string }>;

function handlerFor(channel: string): IpcHandler {
  return mockHandle.mock.calls.find((c) => c[0] === channel)?.[1] as IpcHandler;
}

let nextSenderId = 5000;
function makeEvent() {
  const id = nextSenderId++;
  return {
    senderId: id,
    event: {
      sender: { id, isDestroyed: () => false, once: vi.fn() },
      senderFrame: { url: 'file:///app/dist/web/index.html', parent: null },
    },
  };
}

async function openSocket(extra: Record<string, unknown> = {}) {
  const { event, senderId } = makeEvent();
  const res = await handlerFor(IPC.ws.connect)(event, {
    connectionId: 'c1',
    url: 'wss://echo.example.com/socket',
    ...extra,
  });
  expect(res.success).toBe(true);
  const ws = wsMock.FakeWebSocket.instances.at(-1)!;
  return { event, senderId, ws };
}

function emitted(channel: string): unknown[] {
  return mockEmitTo.mock.calls.filter((c) => c[1] === channel).map((c) => c[2]);
}

describe('websocket-handler control frames', () => {
  beforeEach(() => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    mockHandle.mockClear();
    mockEmitTo.mockClear();
    wsMock.FakeWebSocket.instances.length = 0;
    registerWebSocketHandlerIPC();
  });
  afterEach(() => stopWebSocketCleanup());

  describe('#915 custom close code / reason', () => {
    it('sends the chosen close code and reason', async () => {
      const { event, ws } = await openSocket();
      const res = await handlerFor(IPC.ws.disconnect)(event, {
        connectionId: 'c1',
        code: 4001,
        reason: 'test over',
      });
      expect(res).toEqual({ success: true });
      expect(ws.close).toHaveBeenCalledWith(4001, 'test over');
    });

    it('sends a code with an empty reason when only the code is given', async () => {
      const { event, ws } = await openSocket();
      await handlerFor(IPC.ws.disconnect)(event, { connectionId: 'c1', code: 3000 });
      expect(ws.close).toHaveBeenCalledWith(3000, '');
    });

    it('keeps the legacy default (1000, "Client disconnected") without a code', async () => {
      const { event, ws } = await openSocket();
      await handlerFor(IPC.ws.disconnect)(event, { connectionId: 'c1' });
      expect(ws.close).toHaveBeenCalledWith(1000, 'Client disconnected');
    });

    it('rejects an RFC-invalid close code at the IPC boundary', async () => {
      const { event, ws } = await openSocket();
      await expect(
        handlerFor(IPC.ws.disconnect)(event, { connectionId: 'c1', code: 1006 })
      ).rejects.toThrow(/Invalid IPC payload for ws:disconnect/);
      expect(ws.close).not.toHaveBeenCalled();
    });
  });

  describe('#919 ping / pong', () => {
    it('sends a ping with the UTF-8 payload and reports RTT on the matching pong', async () => {
      const now = vi.spyOn(performance, 'now');
      now.mockReturnValue(1_000);
      const { event, senderId, ws } = await openSocket();

      const res = await handlerFor(IPC.ws.ping)(event, { connectionId: 'c1', payload: 'hello' });
      expect(res).toEqual({ success: true });
      expect(ws.ping).toHaveBeenCalledWith(
        Buffer.from('hello', 'utf8'),
        undefined,
        expect.any(Function)
      );

      now.mockReturnValue(1_042.4);
      ws.fire('pong', Buffer.from('hello'));
      expect(mockEmitTo).toHaveBeenCalledWith(senderId, 'ws:pong:c1', {
        data: 'hello',
        rttMs: 42,
      });
      now.mockRestore();
    });

    it('forwards an unsolicited pong without an RTT', async () => {
      const { ws } = await openSocket();
      ws.fire('pong', Buffer.from('surprise'));
      expect(emitted('ws:pong:c1')).toEqual([{ data: 'surprise' }]);
    });

    it('forwards server-initiated pings', async () => {
      const { senderId, ws } = await openSocket();
      ws.fire('ping', Buffer.from('keepalive'));
      expect(mockEmitTo).toHaveBeenCalledWith(senderId, 'ws:ping-received:c1', {
        data: 'keepalive',
      });
    });

    it('uses a per-ping nonce for an empty payload so a stray empty pong cannot fake RTT', async () => {
      const { event, ws } = await openSocket();
      await handlerFor(IPC.ws.ping)(event, { connectionId: 'c1' });
      await handlerFor(IPC.ws.ping)(event, { connectionId: 'c1', payload: '' });
      const first = (ws.ping.mock.calls[0]![0] as Buffer).toString('utf8');
      const second = (ws.ping.mock.calls[1]![0] as Buffer).toString('utf8');
      expect(first.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(first)).toBeLessThanOrEqual(125);
      expect(second).not.toBe(first);

      // Unsolicited empty pong: no RTT, and the outstanding pings stay pending.
      ws.fire('pong', Buffer.alloc(0));
      // The genuine pong echoes the nonce; the renderer sees the user's (empty) payload.
      ws.fire('pong', Buffer.from(second));
      const pongs = emitted('ws:pong:c1') as Array<{ data: string; rttMs?: number }>;
      expect(pongs[0]).toEqual({ data: '' });
      expect(pongs[1]?.data).toBe('');
      expect(pongs[1]?.rttMs).toBeTypeOf('number');
    });

    it('refuses a ping for a connection owned by a different renderer', async () => {
      const { ws } = await openSocket();
      const other = makeEvent();
      const res = await handlerFor(IPC.ws.ping)(other.event, { connectionId: 'c1' });
      expect(res).toEqual({ success: false, error: 'Not connected' });
      expect(ws.ping).not.toHaveBeenCalled();
    });

    it('refuses when not connected', async () => {
      const { event, ws } = await openSocket();

      const missing = await handlerFor(IPC.ws.ping)(event, { connectionId: 'other' });
      expect(missing).toEqual({ success: false, error: 'Not connected' });

      ws.readyState = 3;
      const closed = await handlerFor(IPC.ws.ping)(event, { connectionId: 'c1' });
      expect(closed).toEqual({ success: false, error: 'Not connected' });
    });

    it('reports an asynchronous ping write failure and does not track it for RTT', async () => {
      const { event, ws } = await openSocket();
      ws.ping.mockImplementationOnce(
        (_data?: unknown, _mask?: boolean, cb?: (err?: Error) => void) => {
          setTimeout(() => cb?.(new Error('write EPIPE')), 0);
        }
      );
      const res = await handlerFor(IPC.ws.ping)(event, { connectionId: 'c1', payload: 'lost' });
      expect(res).toEqual({ success: false, error: 'write EPIPE' });
      ws.fire('pong', Buffer.from('lost'));
      expect(emitted('ws:pong:c1')).toEqual([{ data: 'lost' }]);
    });

    it('reports a ping failure from the socket', async () => {
      const { event, ws } = await openSocket();
      ws.ping.mockImplementation(() => {
        throw new Error('boom');
      });
      const res = await handlerFor(IPC.ws.ping)(event, { connectionId: 'c1' });
      expect(res).toEqual({ success: false, error: 'boom' });
    });

    it('rejects an oversized ping payload at the IPC boundary', async () => {
      const { event, ws } = await openSocket();
      await expect(
        handlerFor(IPC.ws.ping)(event, { connectionId: 'c1', payload: 'a'.repeat(126) })
      ).rejects.toThrow(/Invalid IPC payload for ws:ping/);
      expect(ws.ping).not.toHaveBeenCalled();
    });

    it('bounds the outstanding-ping table', async () => {
      const { event, ws } = await openSocket();
      for (let i = 0; i < 100; i++) {
        await handlerFor(IPC.ws.ping)(event, { connectionId: 'c1', payload: `p${i}` });
      }
      // The oldest pings were evicted: their pong carries no RTT.
      ws.fire('pong', Buffer.from('p0'));
      ws.fire('pong', Buffer.from('p99'));
      const pongs = emitted('ws:pong:c1') as Array<{ data: string; rttMs?: number }>;
      expect(pongs[0]).toEqual({ data: 'p0' });
      expect(pongs[1]?.rttMs).toBeTypeOf('number');
    });
  });

  describe('#923 negotiated subprotocol / extensions + permessage-deflate', () => {
    it('surfaces the negotiated subprotocol and extensions on open', async () => {
      const { senderId, ws } = await openSocket();
      ws.protocol = 'graphql-transport-ws';
      ws.extensions = 'permessage-deflate';
      ws.fire('upgrade', {
        headers: { 'sec-websocket-extensions': 'permessage-deflate; client_max_window_bits=15' },
      });
      ws.fire('open');
      expect(mockEmitTo).toHaveBeenCalledWith(senderId, 'ws:open:c1', {
        protocol: 'graphql-transport-ws',
        extensions: 'permessage-deflate; client_max_window_bits=15',
      });
    });

    it('redacts main-resolved secrets from the negotiated protocol and extensions', async () => {
      const { senderId, ws } = await openSocket({
        auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'h-token' } } },
      });
      ws.protocol = 'proto-keychain-token';
      ws.extensions = 'ext-keychain-token';
      ws.fire('open');
      const open = mockEmitTo.mock.calls.find((c) => c[0] === senderId && c[1] === 'ws:open:c1');
      expect(JSON.stringify(open?.[2])).not.toContain('keychain-token');
    });

    it('falls back to ws.extensions when the upgrade header is absent', async () => {
      const { senderId, ws } = await openSocket();
      ws.extensions = 'permessage-deflate';
      ws.fire('open');
      expect(mockEmitTo).toHaveBeenCalledWith(senderId, 'ws:open:c1', {
        protocol: '',
        extensions: 'permessage-deflate',
      });
    });

    it('offers permessage-deflate by default and disables it per connection', async () => {
      await openSocket();
      expect(wsMock.FakeWebSocket.instances[0]!.options?.perMessageDeflate).toBe(true);
      await openSocket({ perMessageDeflate: false });
      expect(wsMock.FakeWebSocket.instances[1]!.options?.perMessageDeflate).toBe(false);
    });
  });
});
