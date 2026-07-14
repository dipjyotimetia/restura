// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// Fake socket.io-client: records lifecycle listeners, the manager's reconnect
// listeners, and the onAny catch-all so tests can fire connect/disconnect/
// application events without a real network connection.
const sioMock = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  class FakeManager {
    private listeners = new Map<string, Listener[]>();
    on(evt: string, cb: Listener): this {
      const arr = this.listeners.get(evt) ?? [];
      arr.push(cb);
      this.listeners.set(evt, arr);
      return this;
    }
    fire(evt: string, ...args: unknown[]): void {
      for (const cb of this.listeners.get(evt) ?? []) cb(...args);
    }
  }
  class FakeSocket {
    static instances: FakeSocket[] = [];
    id: string;
    connected = true;
    io = new FakeManager();
    url: string;
    opts: unknown;
    emit = vi.fn();
    disconnect = vi.fn(() => {
      this.connected = false;
    });
    private listeners = new Map<string, Listener[]>();
    private anyListeners: Listener[] = [];
    constructor(url: string, opts: unknown) {
      this.url = url;
      this.opts = opts;
      FakeSocket.instances.push(this);
      this.id = `sock-${FakeSocket.instances.length}`;
    }
    on(evt: string, cb: Listener): this {
      const arr = this.listeners.get(evt) ?? [];
      arr.push(cb);
      this.listeners.set(evt, arr);
      return this;
    }
    onAny(cb: Listener): this {
      this.anyListeners.push(cb);
      return this;
    }
    fire(evt: string, ...args: unknown[]): void {
      for (const cb of this.listeners.get(evt) ?? []) cb(...args);
    }
    /** Deliver an application event the way socket.io feeds onAny: (eventName, ...args). */
    fireAny(eventName: string, ...args: unknown[]): void {
      for (const cb of this.anyListeners) cb(eventName, ...args);
    }
  }
  const io = vi.fn((url: string, opts: unknown) => new FakeSocket(url, opts));
  return { FakeSocket, io };
});

vi.mock('electron', () => ({ ipcMain: { handle: mockHandle, removeHandler: vi.fn() } }));
// The handler loads socket.io-client lazily via a memoized dynamic import;
// vitest intercepts dynamic imports too, so this mock covers it.
vi.mock('socket.io-client', () => ({ io: sioMock.io }));
// StreamRegistry + the handler emit through ipc-utils; mock it so emissions are
// observable and the real `electron` import inside ipc-utils never loads.
vi.mock('../ipc/ipc-utils', () => ({ emitTo: mockEmitTo }));
vi.mock('../security/safe-connect', () => ({
  resolveSafeAddress: mockResolveSafe,
  createPinnedLookup: () => vi.fn(),
}));

import { socketioChannels } from '@shared/socketio-constants';
import { IPC } from '../../shared/channels';
import {
  registerSocketIoHandlerIPC,
  socketIoRateLimiter,
  stopSocketIoCleanup,
} from '../handlers/socketio-handler';
import { setExecutionPolicy } from '../security/execution-policy';

type IpcHandler = (e: unknown, p: unknown) => Promise<{ success: boolean; error?: string }>;

function handlerFor(channel: string): IpcHandler {
  const call = mockHandle.mock.calls.find((c) => c[0] === channel);
  return call?.[1] as IpcHandler;
}

const TRUSTED_URL = 'file:///app/dist/web/index.html';
let nextSenderId = 2000;

/**
 * Fake IpcMainInvokeEvent. Fresh sender id per event so the real (module-level)
 * socketIoRateLimiter and bindRendererCleanup's per-id dedupe can't leak across tests.
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
  url: 'https://echo.example.com',
});

describe('socketio-handler', () => {
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
    sioMock.io.mockClear();
    sioMock.FakeSocket.instances.length = 0;
    registerSocketIoHandlerIPC();
  });
  afterEach(() => stopSocketIoCleanup());

  it('registers exactly the IPC.socketio channels', () => {
    const channels = mockHandle.mock.calls.map((c) => c[0]).sort();
    expect(channels).toEqual(Object.values(IPC.socketio).sort());
  });

  it('rejects socketio:connect from an untrusted frame before doing any work', async () => {
    const { event } = makeEvent('https://attacker.example/');
    await expect(handlerFor(IPC.socketio.connect)(event, validConnect('c1'))).rejects.toThrow(
      /untrusted frame/
    );
    expect(sioMock.io).not.toHaveBeenCalled();
    expect(mockResolveSafe).not.toHaveBeenCalled();
  });

  it('rejects an invalid payload via the Zod schema (non-http/ws scheme)', async () => {
    const { event } = makeEvent();
    await expect(
      handlerFor(IPC.socketio.connect)(event, { connectionId: 'c1', url: 'ftp://example.com/' })
    ).rejects.toThrow(/Invalid IPC payload for socketio:connect/);
    expect(sioMock.io).not.toHaveBeenCalled();
  });

  it('rejects a connect once the sender has drained its rate-limit bucket', async () => {
    const { event, senderId } = makeEvent();
    try {
      let guard = 0;
      while (socketIoRateLimiter.check(senderId) && guard++ < 1000) {
        /* drain the sender's bucket */
      }
      const res = await handlerFor(IPC.socketio.connect)(event, validConnect('c-rl'));
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Rate limit/);
      expect(sioMock.io).not.toHaveBeenCalled();
    } finally {
      socketIoRateLimiter.dispose(senderId);
    }
  });

  it('forwards lifecycle + application events to the owning renderer', async () => {
    const { event, senderId } = makeEvent();
    const res = await handlerFor(IPC.socketio.connect)(event, validConnect('c1'));
    expect(res.success).toBe(true);
    expect(mockResolveSafe).toHaveBeenCalledWith('https://echo.example.com', {
      allowLocalhost: true,
      allowPrivateIPs: false,
      allowedSchemes: ['http:', 'https:', 'ws:', 'wss:'],
    });

    const socket = sioMock.FakeSocket.instances[0]!;
    socket.fire('connect');
    expect(mockEmitTo).toHaveBeenCalledWith(senderId, socketioChannels.open('c1'), {
      socketId: socket.id,
    });

    socket.fireAny('price-update', { symbol: 'X' }, 42);
    expect(mockEmitTo).toHaveBeenCalledWith(senderId, socketioChannels.event('c1'), {
      eventName: 'price-update',
      args: [{ symbol: 'X' }, 42],
    });

    // Reserved lifecycle events are NOT double-forwarded through the catch-all.
    mockEmitTo.mockClear();
    socket.fireAny('disconnect', 'transport close');
    expect(mockEmitTo).not.toHaveBeenCalled();

    socket.fire('connect_error', new Error('boom'));
    expect(mockEmitTo).toHaveBeenCalledWith(senderId, socketioChannels.error('c1'), {
      message: 'boom',
    });

    socket.io.fire('reconnect_attempt', 2);
    expect(mockEmitTo).toHaveBeenCalledWith(senderId, socketioChannels.reconnectAttempt('c1'), {
      attempt: 2,
    });

    // Unexpected disconnect (not explicitly requested) is forwarded as close.
    socket.fire('disconnect', 'transport close');
    expect(mockEmitTo).toHaveBeenCalledWith(senderId, socketioChannels.close('c1'), {
      reason: 'transport close',
    });
  });

  it('socketio:emit forwards to the socket and reports Not connected for unknown ids', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.socketio.connect)(event, validConnect('c1'));
    const socket = sioMock.FakeSocket.instances[0]!;

    const ok = await handlerFor(IPC.socketio.emit)(event, {
      connectionId: 'c1',
      eventName: 'ping',
      args: ['a', 1],
    });
    expect(ok).toEqual({ success: true });
    expect(socket.emit).toHaveBeenCalledWith('ping', 'a', 1);

    const missing = await handlerFor(IPC.socketio.emit)(event, {
      connectionId: 'nope',
      eventName: 'ping',
      args: [],
    });
    expect(missing).toEqual({ success: false, error: 'Not connected' });
  });

  it('explicit disconnect tears the socket down and suppresses the trailing close event', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.socketio.connect)(event, validConnect('c1'));
    const socket = sioMock.FakeSocket.instances[0]!;

    const res = await handlerFor(IPC.socketio.disconnect)(event, { connectionId: 'c1' });
    expect(res).toEqual({ success: true });
    expect(socket.disconnect).toHaveBeenCalled();

    mockEmitTo.mockClear();
    socket.fire('disconnect', 'io client disconnect');
    expect(mockEmitTo.mock.calls.some((c) => c[1] === socketioChannels.close('c1'))).toBe(false);

    // The entry is gone: a subsequent emit reports Not connected.
    const after = await handlerFor(IPC.socketio.emit)(event, {
      connectionId: 'c1',
      eventName: 'ping',
      args: [],
    });
    expect(after).toEqual({ success: false, error: 'Not connected' });
  });

  it('reconnecting with the same id disposes the previous socket', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.socketio.connect)(event, validConnect('c1'));
    await handlerFor(IPC.socketio.connect)(event, validConnect('c1'));
    const [first, second] = sioMock.FakeSocket.instances;
    expect(first!.disconnect).toHaveBeenCalled();
    expect(second!.disconnect).not.toHaveBeenCalled();
  });

  it('tears down the connection when its renderer is destroyed', async () => {
    const { event, destroy } = makeEvent();
    await handlerFor(IPC.socketio.connect)(event, validConnect('c1'));
    const socket = sioMock.FakeSocket.instances[0]!;

    destroy();
    expect(socket.disconnect).toHaveBeenCalled();
    const res = await handlerFor(IPC.socketio.emit)(event, {
      connectionId: 'c1',
      eventName: 'x',
      args: [],
    });
    expect(res).toEqual({ success: false, error: 'Not connected' });
  });

  it('stopSocketIoCleanup disconnects every live connection (register/teardown symmetry)', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.socketio.connect)(event, validConnect('c1'));
    await handlerFor(IPC.socketio.connect)(event, validConnect('c2'));

    stopSocketIoCleanup();
    for (const socket of sioMock.FakeSocket.instances) {
      expect(socket.disconnect).toHaveBeenCalled();
    }
  });

  it('fails clearly when execution policy proxy cannot be honored by DNS-pinned lookup', async () => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: {
        enabled: true,
        type: 'socks5',
        host: 'proxy.example.test',
        port: 1080,
        bypassList: [],
      },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });

    const { event } = makeEvent();
    const res = await handlerFor(IPC.socketio.connect)(event, validConnect('policy'));
    expect(res).toEqual({
      success: false,
      error: 'Configured SOCKS5 proxy cannot be honored by this DNS-pinned connection',
    });
    expect(mockResolveSafe).not.toHaveBeenCalled();
    expect(sioMock.io).not.toHaveBeenCalled();
  });
});
