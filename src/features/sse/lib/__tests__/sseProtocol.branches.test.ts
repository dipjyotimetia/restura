import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SseRequest } from '@/types';

const mockExecute = vi.hoisted(() => vi.fn());
const platform = vi.hoisted(() => ({ electron: false, api: undefined as unknown }));
vi.mock('@/lib/shared/transport', () => ({ executeProxiedStreamingRequest: mockExecute }));
vi.mock('@/lib/shared/platform', () => ({
  isElectron: () => platform.electron,
  getElectronAPI: () => platform.api,
}));

import { sseProtocol } from '../../protocol';

const enc = new TextEncoder();

function req(over: Partial<SseRequest> = {}): SseRequest {
  return {
    id: 'r',
    name: 'n',
    type: 'sse',
    url: 'https://example.com/stream',
    headers: [],
    params: [],
    auth: { type: 'none' },
    reconnectOnResume: true,
    ...over,
  } as SseRequest;
}

const start = (r: unknown, signal: AbortSignal = new AbortController().signal) =>
  sseProtocol.startStream!(r, { signal, variables: {} });

/** A controllable stream response. */
function controlled() {
  const queue: Array<{ done: boolean; value?: Uint8Array }> = [];
  let waiter: ((v: { done: boolean; value?: Uint8Array }) => void) | null = null;
  let failNext: Error | null = null;
  const cancel = vi.fn(async () => {
    push({ done: true });
  });
  function push(item: { done: boolean; value?: Uint8Array }) {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(item);
    } else queue.push(item);
  }
  const response = {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader: () => ({
        read: () => {
          if (failNext) return Promise.reject(failNext);
          const next = queue.shift();
          if (next) return Promise.resolve(next);
          return new Promise<{ done: boolean; value?: Uint8Array }>((res) => {
            waiter = res;
          });
        },
        cancel,
      }),
    },
  };
  return {
    response,
    cancel,
    send: (text: string) => push({ done: false, value: enc.encode(text) }),
    end: () => push({ done: true }),
    fail: (e: Error) => {
      failNext = e;
      if (waiter) {
        const w = waiter;
        waiter = null;
        // Resolve the pending read with a done so the loop re-reads and hits the failure.
        w({ done: false, value: new Uint8Array() });
      }
    },
  };
}

describe('sseProtocol module', () => {
  it('has a default request and refuses the registry runner', async () => {
    const d = sseProtocol.defaultRequest() as SseRequest;
    expect(d).toMatchObject({ type: 'sse', url: '', reconnectOnResume: true });
    await expect(sseProtocol.runRequest({} as never, {} as never)).rejects.toThrow(
      /long-lived stream/
    );
  });

  it('leaves non-SSE requests untouched when injecting variables', () => {
    const http = { type: 'http', url: '{{a}}' } as never;
    expect(sseProtocol.injectVariables!(http, { a: 'b' })).toBe(http);
  });
});

describe('sseProtocol.startStream validation', () => {
  it.each([
    [null, 'unknown'],
    [undefined, 'unknown'],
    ['x', 'unknown'],
    [{ type: 'http' }, 'http'],
    [{ type: 5 }, 'unknown'],
  ])('rejects %j', async (r, kind) => {
    await expect(start(r)).rejects.toThrow(`SSE startStream cannot run ${kind} request`);
  });

  it('rejects a blank URL', async () => {
    await expect(start(req({ url: '  ' }))).rejects.toThrow('SSE request has no URL');
  });
});

describe('sseProtocol.startStream (web)', () => {
  beforeEach(() => {
    platform.electron = false;
    mockExecute.mockReset();
  });

  it('builds the URL and headers from enabled params/headers, skipping disabled and blank ones', async () => {
    const c = controlled();
    mockExecute.mockResolvedValue(c.response);
    const handle = await start(
      req({
        headers: [
          { id: '1', key: 'X-On', value: '1', enabled: true },
          { id: '2', key: 'X-Off', value: '2', enabled: false },
          { id: '3', key: '', value: 'blank', enabled: true },
        ],
        params: [
          { id: '4', key: 'a', value: 'b', enabled: true },
          { id: '5', key: 'off', value: 'x', enabled: false },
          { id: '6', key: '', value: 'x', enabled: true },
        ],
      })
    );
    const spec = mockExecute.mock.calls[0]?.[0] as { url: string; headers: Record<string, string> };
    expect(spec.url).toBe('https://example.com/stream?a=b');
    expect(spec.headers).toEqual({ Accept: 'text/event-stream', 'X-On': '1' });
    c.end();
    await handle.close();
  });

  it('keeps the raw URL when params cannot be applied to it', async () => {
    const c = controlled();
    mockExecute.mockResolvedValue(c.response);
    const handle = await start(
      req({ url: 'not-absolute', params: [{ id: '1', key: 'a', value: 'b', enabled: true }] })
    );
    expect((mockExecute.mock.calls[0]?.[0] as { url: string }).url).toBe('not-absolute');
    c.end();
    await handle.close();
  });

  it('fails on a non-2xx reply and on a missing body', async () => {
    mockExecute.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Boom' });
    await expect(start(req())).rejects.toThrow('SSE HTTP 500 Boom');
    mockExecute.mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', body: null });
    await expect(start(req())).rejects.toThrow('SSE response has no body');
  });

  it('yields events as they arrive and ends when the stream ends', async () => {
    const c = controlled();
    mockExecute.mockResolvedValue(c.response);
    const handle = await start(req());
    const it = handle.events[Symbol.asyncIterator]();
    const first = it.next();
    c.send('data: one\n\n');
    expect((await first).value).toMatchObject({ data: 'one' });
    c.send('data: two\n\ndata: three\n\n');
    expect((await it.next()).value).toMatchObject({ data: 'two' });
    expect((await it.next()).value).toMatchObject({ data: 'three' });
    const last = it.next();
    c.end();
    expect((await last).done).toBe(true);
    // close() after the stream already ended is a no-op.
    await handle.close();
    expect(c.cancel).not.toHaveBeenCalled();
  });

  it('close() cancels the reader and unlinks the caller signal', async () => {
    const c = controlled();
    mockExecute.mockResolvedValue(c.response);
    const ctrl = new AbortController();
    const remove = vi.spyOn(ctrl.signal, 'removeEventListener');
    const handle = await start(req(), ctrl.signal);
    await handle.close();
    expect(c.cancel).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('close() tolerates a reader that fails to cancel', async () => {
    const c = controlled();
    c.cancel.mockImplementation(async () => {
      throw new Error('nope');
    });
    mockExecute.mockResolvedValue(c.response);
    const handle = await start(req());
    // Let the drain loop see an abort so close() can settle.
    await expect(
      Promise.race([handle.close(), new Promise((r) => setTimeout(() => r('hung'), 50))])
    ).resolves.toBeDefined();
    c.end();
  });

  it('abandoning the iterator cancels the stream', async () => {
    const c = controlled();
    mockExecute.mockResolvedValue(c.response);
    const handle = await start(req());
    const it = handle.events[Symbol.asyncIterator]();
    const next = it.next();
    c.send('data: x\n\n');
    await next;
    await it.return?.(undefined);
    expect(c.cancel).toHaveBeenCalledOnce();
  });

  it('abandoning the iterator tolerates a reader that fails to cancel', async () => {
    const c = controlled();
    c.cancel.mockRejectedValue(new Error('nope'));
    mockExecute.mockResolvedValue(c.response);
    const handle = await start(req());
    const it = handle.events[Symbol.asyncIterator]();
    const next = it.next();
    c.send('data: x\n\n');
    await next;
    await expect(it.return?.(undefined)).resolves.toBeDefined();
  });

  it('a read error ends the stream quietly', async () => {
    const c = controlled();
    mockExecute.mockResolvedValue(c.response);
    const handle = await start(req());
    const it = handle.events[Symbol.asyncIterator]();
    const next = it.next();
    c.fail(new Error('reset'));
    expect((await next).done).toBe(true);
  });

  it('an abort fed by the caller aborts the transport signal', async () => {
    const c = controlled();
    mockExecute.mockResolvedValue(c.response);
    const ctrl = new AbortController();
    await start(req(), ctrl.signal);
    const transportSignal = (mockExecute.mock.calls[0]?.[1] as { signal: AbortSignal }).signal;
    expect(transportSignal.aborted).toBe(false);
    ctrl.abort();
    expect(transportSignal.aborted).toBe(true);
    c.end();
  });

  it('starts aborted when the caller signal is already aborted', async () => {
    const c = controlled();
    mockExecute.mockResolvedValue(c.response);
    const ctrl = new AbortController();
    ctrl.abort();
    const handle = await start(req(), ctrl.signal);
    expect((mockExecute.mock.calls[0]?.[1] as { signal: AbortSignal }).signal.aborted).toBe(true);
    const it = handle.events[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(true);
  });
});

describe('sseProtocol.startStream (Electron)', () => {
  type Listener = (payload?: unknown) => void;
  let listeners: Map<string, Listener>;
  let connect: ReturnType<typeof vi.fn>;
  let disconnect: ReturnType<typeof vi.fn>;
  const emit = (ch: string, payload?: unknown) => {
    for (const [k, cb] of listeners) if (k.startsWith(`${ch}:`)) cb(payload);
  };

  beforeEach(() => {
    platform.electron = true;
    listeners = new Map();
    connect = vi.fn(async () => ({ success: true }));
    disconnect = vi.fn(async () => ({ success: true }));
    platform.api = {
      sse: {
        connect,
        disconnect,
        on: (ch: string, cb: Listener) => listeners.set(ch, cb),
        removeListener: vi.fn(),
        removeAllListeners: (ch: string) => listeners.delete(ch),
      },
    };
  });
  afterEach(() => {
    platform.electron = false;
  });

  it('throws when the bridge is unavailable', async () => {
    platform.api = {};
    await expect(start(req())).rejects.toThrow(/not available/);
  });

  it('rejects with a default message when connect fails without detail', async () => {
    connect.mockResolvedValueOnce({ success: false });
    await expect(start(req())).rejects.toThrow('SSE connect failed');
  });

  it('queues events then raises a reported error once the stream closes', async () => {
    const handle = await start(req());
    emit('sse:event', { event: 'm', data: 'a' });
    emit('sse:error', { message: 'upstream died' });
    emit('sse:close');
    const it = handle.events[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ event: 'm', data: 'a' });
    await expect(it.next()).rejects.toThrow('upstream died');
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('uses a default error text for an error event without a message', async () => {
    const handle = await start(req());
    emit('sse:error', undefined);
    emit('sse:close');
    await expect(handle.events[Symbol.asyncIterator]().next()).rejects.toThrow('SSE stream error');
  });

  it('wakes a waiting consumer on event and on close', async () => {
    const handle = await start(req());
    const it = handle.events[Symbol.asyncIterator]();
    const first = it.next();
    emit('sse:event', { event: 'm', data: 'z' });
    expect((await first).value).toMatchObject({ data: 'z' });
    const done = it.next();
    emit('sse:close');
    expect((await done).done).toBe(true);
  });

  it('disconnects once for an abort followed by close()', async () => {
    const ctrl = new AbortController();
    const handle = await start(req(), ctrl.signal);
    ctrl.abort();
    await handle.close();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('disconnects immediately for an already-aborted signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await start(req(), ctrl.signal);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('swallows a failing disconnect', async () => {
    const handle = await start(req());
    disconnect.mockRejectedValueOnce(new Error('x'));
    await expect(handle.close()).resolves.toBeUndefined();
  });
});
