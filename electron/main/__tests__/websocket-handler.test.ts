// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const mockResolveSafe = vi.hoisted(() =>
  vi.fn(async () => ({
    host: 'echo.example.com',
    ip: '203.0.113.1',
    port: 443,
    family: 4 as const,
  }))
);

// Fake `ws` socket: records constructor calls and lifecycle listeners so tests
// can fire open/message/close without a real network connection.
const wsMock = vi.hoisted(() => {
  class FakeWebSocket {
    static OPEN = 1;
    static instances: FakeWebSocket[] = [];
    readyState = 1; // OPEN
    protocol = '';
    url: string;
    send = vi.fn();
    close = vi.fn();
    terminate = vi.fn();
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor(url: string) {
      this.url = url;
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
// StreamRegistry emits through ipc-utils; mock it so emissions are observable
// and the real `electron` import inside ipc-utils never loads.
vi.mock('../ipc/ipc-utils', () => ({ emitTo: mockEmitTo }));
vi.mock('../security/safe-connect', () => ({
  resolveSafeAddress: mockResolveSafe,
  createPinnedLookup: () => vi.fn(),
}));

import { IPC } from '../../shared/channels';
import {
  registerWebSocketHandlerIPC,
  stopWebSocketCleanup,
  wsRateLimiter,
} from '../handlers/websocket-handler';
import { setExecutionPolicy } from '../security/execution-policy';

type IpcHandler = (e: unknown, p: unknown) => Promise<{ success: boolean; error?: string }>;

function handlerFor(channel: string): IpcHandler {
  const call = mockHandle.mock.calls.find((c) => c[0] === channel);
  return call?.[1] as IpcHandler;
}

const TRUSTED_URL = 'file:///app/dist/web/index.html';
let nextSenderId = 1000;

/**
 * Fake IpcMainInvokeEvent. Fresh sender id per event so the real (module-level)
 * wsRateLimiter and bindRendererCleanup's per-id dedupe can't leak across tests.
 */
function makeEvent(frameUrl = TRUSTED_URL) {
  const id = nextSenderId++;
  const destroyedListeners: Array<() => void> = [];
  return {
    senderId: id,
    event: {
      sender: {
        id,
        isDestroyed: () => false,
        once: (evt: string, cb: () => void) => {
          if (evt === 'destroyed') destroyedListeners.push(cb);
        },
      },
      senderFrame: { url: frameUrl, parent: null },
    },
    destroy: () => destroyedListeners.splice(0).forEach((cb) => cb()),
  };
}

const validConnect = (connectionId: string) => ({
  connectionId,
  url: 'wss://echo.example.com/socket',
});

describe('websocket-handler', () => {
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
    mockResolveSafe.mockClear();
    wsMock.FakeWebSocket.instances.length = 0;
    registerWebSocketHandlerIPC();
  });
  afterEach(() => stopWebSocketCleanup());

  it('registers exactly the IPC.ws channels', () => {
    const channels = mockHandle.mock.calls.map((c) => c[0]).sort();
    expect(channels).toEqual(Object.values(IPC.ws).sort());
  });

  it('rejects ws:connect from an untrusted frame before doing any work', async () => {
    const { event } = makeEvent('https://attacker.example/');
    await expect(handlerFor(IPC.ws.connect)(event, validConnect('c1'))).rejects.toThrow(
      /untrusted frame/
    );
    expect(wsMock.FakeWebSocket.instances).toHaveLength(0);
  });

  it('rejects an invalid payload via the Zod schema (non-ws scheme)', async () => {
    const { event } = makeEvent();
    await expect(
      handlerFor(IPC.ws.connect)(event, { connectionId: 'c1', url: 'http://example.com/' })
    ).rejects.toThrow(/Invalid IPC payload for ws:connect/);
  });

  it('rejects a connect once the sender has drained its rate-limit bucket', async () => {
    const { event, senderId } = makeEvent();
    try {
      let guard = 0;
      while (wsRateLimiter.check(senderId) && guard++ < 1000) {
        /* drain the sender's bucket */
      }
      const res = await handlerFor(IPC.ws.connect)(event, validConnect('c-rl'));
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Rate limit/);
      expect(wsMock.FakeWebSocket.instances).toHaveLength(0);
    } finally {
      wsRateLimiter.dispose(senderId);
    }
  });

  it('emits targeted open/message/close events over the connection lifecycle', async () => {
    const { event, senderId } = makeEvent();
    const res = await handlerFor(IPC.ws.connect)(event, validConnect('c1'));
    expect(res.success).toBe(true);
    expect(mockResolveSafe).toHaveBeenCalledWith('wss://echo.example.com/socket', {
      allowLocalhost: true,
      allowPrivateIPs: false,
      allowedSchemes: ['ws:', 'wss:'],
    });

    const ws = wsMock.FakeWebSocket.instances[0]!;
    ws.fire('open');
    expect(mockEmitTo).toHaveBeenCalledWith(senderId, 'ws:open:c1', { protocol: '' });

    ws.fire('message', Buffer.from('hi'), false);
    expect(mockEmitTo).toHaveBeenCalledWith(senderId, 'ws:message:c1', {
      type: 'text',
      data: 'hi',
    });

    ws.fire('message', Buffer.from('bin'), true);
    expect(mockEmitTo).toHaveBeenCalledWith(senderId, 'ws:message:c1', {
      type: 'binary',
      data: Buffer.from('bin').toString('base64'),
    });

    // Unexpected close (not explicitly requested) is forwarded.
    ws.fire('close', 1006, Buffer.from('gone'));
    expect(mockEmitTo).toHaveBeenCalledWith(senderId, 'ws:close:c1', {
      code: 1006,
      reason: 'gone',
    });
  });

  it('ws:send forwards to the open socket and reports Not connected for unknown ids', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.ws.connect)(event, validConnect('c1'));
    const ws = wsMock.FakeWebSocket.instances[0]!;

    const ok = await handlerFor(IPC.ws.send)(event, { connectionId: 'c1', message: 'ping' });
    expect(ok).toEqual({ success: true });
    expect(ws.send).toHaveBeenCalledWith('ping');

    const missing = await handlerFor(IPC.ws.send)(event, {
      connectionId: 'nope',
      message: 'ping',
    });
    expect(missing).toEqual({ success: false, error: 'Not connected' });
  });

  it('explicit disconnect closes gracefully (1000) and suppresses the trailing close event', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.ws.connect)(event, validConnect('c1'));
    const ws = wsMock.FakeWebSocket.instances[0]!;

    const res = await handlerFor(IPC.ws.disconnect)(event, { connectionId: 'c1' });
    expect(res).toEqual({ success: true });
    expect(ws.close).toHaveBeenCalledWith(1000, 'Client disconnected');

    mockEmitTo.mockClear();
    ws.fire('close', 1000, Buffer.from(''));
    expect(mockEmitTo.mock.calls.some((c) => c[1] === 'ws:close:c1')).toBe(false);
  });

  it('reconnecting with the same id hard-terminates the previous socket', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.ws.connect)(event, validConnect('c1'));
    await handlerFor(IPC.ws.connect)(event, validConnect('c1'));
    const [first, second] = wsMock.FakeWebSocket.instances;
    expect(first!.terminate).toHaveBeenCalled();
    expect(second!.terminate).not.toHaveBeenCalled();
  });

  it('tears down the connection when its renderer is destroyed', async () => {
    const { event, destroy } = makeEvent();
    await handlerFor(IPC.ws.connect)(event, validConnect('c1'));
    const ws = wsMock.FakeWebSocket.instances[0]!;

    destroy();
    expect(ws.terminate).toHaveBeenCalled();
    // The entry is gone: a subsequent send reports Not connected.
    const res = await handlerFor(IPC.ws.send)(event, { connectionId: 'c1', message: 'x' });
    expect(res).toEqual({ success: false, error: 'Not connected' });
  });

  it('stopWebSocketCleanup terminates every live connection (register/teardown symmetry)', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.ws.connect)(event, validConnect('c1'));
    await handlerFor(IPC.ws.connect)(event, validConnect('c2'));

    stopWebSocketCleanup();
    for (const ws of wsMock.FakeWebSocket.instances) {
      expect(ws.terminate).toHaveBeenCalled();
    }
  });

  it('fails clearly when execution policy proxy cannot be honored by DNS-pinned lookup', async () => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: {
        enabled: true,
        type: 'http',
        host: 'proxy.example.test',
        port: 3128,
        bypassList: [],
      },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });

    const { event } = makeEvent();
    const res = await handlerFor(IPC.ws.connect)(event, validConnect('policy'));
    expect(res).toEqual({
      success: false,
      error: 'Configured HTTP proxy cannot be honored by this DNS-pinned connection',
    });
    expect(mockResolveSafe).not.toHaveBeenCalled();
    expect(wsMock.FakeWebSocket.instances).toHaveLength(0);
  });
});
