import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ electron: false, api: undefined as unknown }));
vi.mock('@/lib/shared/platform', () => ({
  isElectron: () => platform.electron,
  getElectronAPI: () => platform.api,
}));

import { websocketProtocol } from '../../protocol';

type Handle = Awaited<ReturnType<NonNullable<typeof websocketProtocol.startStream>>> & {
  send: (frame: string) => void;
};
const start = (request: unknown, signal: AbortSignal = new AbortController().signal) =>
  websocketProtocol.startStream!(request, { signal, variables: {} }) as Promise<Handle>;

describe('websocketProtocol module', () => {
  it('has no request shape and refuses the registry runner', async () => {
    expect(() => websocketProtocol.defaultRequest()).toThrow(/no Request shape/);
    await expect(websocketProtocol.runRequest({} as never, {} as never)).rejects.toThrow(
      /full-duplex/
    );
  });

  it.each([[null], ['str'], [{ type: 'http', url: 'x' }], [{ type: 'websocket', url: 5 }]])(
    'rejects non-inline-websocket request %j',
    async (req) => {
      await expect(start(req)).rejects.toThrow(/inline-websocket/);
    }
  );

  it('rejects a blank URL', async () => {
    await expect(start({ type: 'websocket', url: '   ' })).rejects.toThrow(/no URL/);
  });
});

/** Minimal controllable WebSocket double. */
class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static last: FakeSocket;
  readyState = 0;
  sent: string[] = [];
  closeArgs: Array<[number | undefined, string | undefined]> = [];
  closeThrows = false;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    super();
    FakeSocket.last = this;
  }
  send(frame: string) {
    this.sent.push(frame);
  }
  close(code?: number, reason?: string) {
    if (this.closeThrows) throw new Error('already closed');
    this.closeArgs.push([code, reason]);
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  fail() {
    this.onerror?.();
    this.dispatchEvent(new Event('error'));
  }
}

describe('websocketProtocol.startStream (web)', () => {
  beforeEach(() => {
    platform.electron = false;
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function opened(signal?: AbortSignal) {
    const p = start({ type: 'websocket', url: 'wss://x.test' }, signal);
    const sock = FakeSocket.last;
    sock.open();
    return { handle: await p, sock };
  }

  it('yields parsed JSON, raw text and non-string frames, then ends on close', async () => {
    const { handle, sock } = await opened();
    const it = handle.events[Symbol.asyncIterator]();
    sock.onmessage?.({ data: '{"a":1}' });
    sock.onmessage?.({ data: 'plain' });
    sock.onmessage?.({ data: 42 });
    expect((await it.next()).value).toEqual({ a: 1 });
    expect((await it.next()).value).toBe('plain');
    expect((await it.next()).value).toBe(42);

    const pending = it.next();
    sock.onclose?.();
    expect((await pending).done).toBe(true);
  });

  it('send only writes while the socket is open', async () => {
    const { handle, sock } = await opened();
    handle.send('hi');
    sock.readyState = 3;
    handle.send('dropped');
    expect(sock.sent).toEqual(['hi']);
  });

  it('close() closes once and is idempotent; ignores a throwing socket', async () => {
    const { handle, sock } = await opened();
    sock.closeThrows = true;
    await handle.close();
    await handle.close();
    expect(sock.closeArgs).toEqual([]);
  });

  it('close() asks the socket to close with the caller reason', async () => {
    const { handle, sock } = await opened();
    await handle.close();
    expect(sock.closeArgs).toEqual([[1000, 'caller-close']]);
  });

  it('closes the socket when the consumer stops iterating early', async () => {
    const { handle, sock } = await opened();
    const it = handle.events[Symbol.asyncIterator]();
    sock.onmessage?.({ data: '1' });
    await it.next();
    await it.return?.(undefined);
    expect(sock.closeArgs).toEqual([[1000, 'iterator-done']]);
  });

  it('swallows a close error on early iterator exit', async () => {
    const { handle, sock } = await opened();
    const it = handle.events[Symbol.asyncIterator]();
    sock.onmessage?.({ data: '1' });
    await it.next();
    sock.closeThrows = true;
    await expect(it.return?.(undefined)).resolves.toBeDefined();
  });

  it('aborting after open closes the socket and ends the stream', async () => {
    const ctrl = new AbortController();
    const { handle, sock } = await opened(ctrl.signal);
    const pending = handle.events[Symbol.asyncIterator]().next();
    ctrl.abort();
    expect((await pending).done).toBe(true);
    expect(sock.closeArgs).toEqual([[1000, 'aborted']]);
  });

  it('abort tolerates a throwing socket.close', async () => {
    const ctrl = new AbortController();
    const { sock } = await opened(ctrl.signal);
    sock.closeThrows = true;
    expect(() => ctrl.abort()).not.toThrow();
  });

  it('rejects when the handshake errors before opening', async () => {
    const p = start({ type: 'websocket', url: 'wss://x.test' });
    FakeSocket.last.fail();
    await expect(p).rejects.toThrow('WebSocket connection failed');
  });

  it('an error after open ends the stream without rejecting', async () => {
    const { handle, sock } = await opened();
    const pending = handle.events[Symbol.asyncIterator]().next();
    sock.fail();
    expect((await pending).done).toBe(true);
  });

  it('rejects with AbortError when aborted before the socket opens', async () => {
    const ctrl = new AbortController();
    const p = start({ type: 'websocket', url: 'wss://x.test' }, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects with AbortError for an already-aborted signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      start({ type: 'websocket', url: 'wss://x.test' }, ctrl.signal)
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('resolves immediately when the socket is already open', async () => {
    class OpenSocket extends FakeSocket {
      override readyState = 1;
    }
    vi.stubGlobal('WebSocket', OpenSocket);
    const handle = await start({ type: 'websocket', url: 'wss://x.test' });
    expect(typeof handle.send).toBe('function');
  });
});

describe('websocketProtocol.startStream (Electron)', () => {
  type Listener = (payload?: unknown) => void;
  let listeners: Map<string, Listener>;
  let connect: ReturnType<typeof vi.fn>;
  let disconnect: ReturnType<typeof vi.fn>;
  let send: ReturnType<typeof vi.fn>;
  const emit = (ch: string, payload?: unknown) => {
    for (const [k, cb] of listeners) if (k.startsWith(`${ch}:`)) cb(payload);
  };

  beforeEach(() => {
    platform.electron = true;
    listeners = new Map();
    connect = vi.fn(async () => ({ success: true }));
    disconnect = vi.fn(async () => ({ success: true }));
    send = vi.fn(async () => ({ success: true }));
    platform.api = {
      websocket: {
        connect,
        disconnect,
        send,
        on: (ch: string, cb: Listener) => listeners.set(ch, cb),
        removeListener: vi.fn(),
        removeAllListeners: (ch: string) => listeners.delete(ch),
      },
    };
  });

  const req = { type: 'websocket', url: 'wss://x.test' };
  async function opened(signal?: AbortSignal) {
    const p = start(req, signal);
    await Promise.resolve();
    emit('ws:open');
    return p;
  }

  it('throws when the bridge is unavailable', async () => {
    platform.api = {};
    await expect(start(req)).rejects.toThrow(/not available/);
  });

  it('yields text (JSON / raw) and binary frames then ends on close', async () => {
    const handle = await opened();
    const it = handle.events[Symbol.asyncIterator]();
    emit('ws:message', { type: 'text', data: '{"k":1}' });
    emit('ws:message', { type: 'text', data: 'not json' });
    emit('ws:message', { type: 'binary', data: 'AAEC' });
    expect((await it.next()).value).toEqual({ k: 1 });
    expect((await it.next()).value).toBe('not json');
    expect((await it.next()).value).toBe('AAEC');
    const pending = it.next();
    emit('ws:close');
    expect((await pending).done).toBe(true);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('send forwards the frame and swallows IPC failures', async () => {
    const handle = await opened();
    send.mockRejectedValueOnce(new Error('x'));
    handle.send('hello');
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ message: 'hello' }));
  });

  it('throws the reported error when the stream closes after an error event', async () => {
    const handle = await opened();
    const it = handle.events[Symbol.asyncIterator]();
    emit('ws:error', { message: 'reset by peer' });
    emit('ws:close');
    await expect(it.next()).rejects.toThrow('reset by peer');
  });

  it('uses the default error text for an error without a message', async () => {
    const handle = await opened();
    const it = handle.events[Symbol.asyncIterator]();
    emit('ws:error', {});
    emit('ws:close');
    await expect(it.next()).rejects.toThrow('WebSocket connection failed');
  });

  it('rejects with the reported error when closed before opening', async () => {
    const p = start(req);
    await Promise.resolve();
    emit('ws:error', { message: 'handshake 403' });
    emit('ws:close');
    await expect(p).rejects.toThrow('handshake 403');
    expect(disconnect).toHaveBeenCalled();
  });

  it('rejects with a default message when closed before opening silently', async () => {
    const p = start(req);
    await Promise.resolve();
    emit('ws:close');
    await expect(p).rejects.toThrow('WebSocket connection failed');
  });

  it('rejects when connect() reports failure, with and without detail', async () => {
    connect.mockResolvedValueOnce({ success: false, error: 'blocked' });
    await expect(start(req)).rejects.toThrow('blocked');
    connect.mockResolvedValueOnce({ success: false });
    await expect(start(req)).rejects.toThrow('WebSocket connection failed');
  });

  it('rejects when connect() itself rejects', async () => {
    connect.mockRejectedValueOnce(new Error('ipc down'));
    await expect(start(req)).rejects.toThrow('ipc down');
  });

  it('ignores a failed connect result once the socket already opened', async () => {
    let resolveConnect: (v: { success: boolean }) => void = () => undefined;
    connect.mockReturnValueOnce(new Promise((r) => (resolveConnect = r)));
    const p = start(req);
    await Promise.resolve();
    emit('ws:open');
    const handle = await p;
    resolveConnect({ success: false });
    await Promise.resolve();
    expect(typeof handle.close).toBe('function');
  });

  it('rejects with AbortError for an already-aborted signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(start(req, ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(disconnect).toHaveBeenCalled();
  });

  it('rejects with AbortError when aborted while connecting', async () => {
    const ctrl = new AbortController();
    const p = start(req, ctrl.signal);
    await Promise.resolve();
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('disconnects when the iterator is abandoned', async () => {
    const handle = await opened();
    const it = handle.events[Symbol.asyncIterator]();
    emit('ws:message', { type: 'text', data: '1' });
    await it.next();
    await it.return?.(undefined);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('swallows a failing disconnect', async () => {
    const handle = await opened();
    disconnect.mockRejectedValueOnce(new Error('x'));
    await expect(handle.close()).resolves.toBeUndefined();
  });
});
