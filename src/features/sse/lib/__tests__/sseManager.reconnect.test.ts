import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecute = vi.hoisted(() => vi.fn());
const platform = vi.hoisted(() => ({ electron: false, api: undefined as unknown }));
vi.mock('@/lib/shared/transport', () => ({ executeProxiedStreamingRequest: mockExecute }));
vi.mock('@/lib/shared/platform', () => ({
  isElectron: () => platform.electron,
  getElectronAPI: () => platform.api,
}));

import { useSseStore } from '@/features/sse/store/useSseStore';
import { sseManager } from '../sseManager';

const URL_ = 'https://example.com/stream';

/** A proxied reply whose body yields `chunks` then ends (server dropped the stream). */
function streamResponse(
  chunks: string[],
  init: { status?: number; contentType?: string } = {}
): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = {
    getReader: () => ({
      read: async () =>
        i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true },
      cancel: async () => undefined,
    }),
    cancel: async () => undefined,
  } as unknown as ReadableStream<Uint8Array>;
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: new Headers({ 'content-type': init.contentType ?? 'text/event-stream' }),
    body,
  } as unknown as Response;
}

function sentHeaders(call: number): Record<string, string> {
  return mockExecute.mock.calls[call]?.[0].headers as Record<string, string>;
}

const conn = (id: string) => useSseStore.getState().connections[id]!;
const messages = (id: string) =>
  conn(id)
    .log.filter((e) => e.kind === 'system')
    .map((e) => (e as { message: string }).message);

describe('sseManager auto-reconnect (web)', () => {
  let id: string;
  beforeEach(() => {
    vi.useFakeTimers();
    mockExecute.mockReset();
    platform.electron = false;
    id = useSseStore.getState().createConnection();
  });
  afterEach(() => {
    sseManager.cleanup();
    vi.useRealTimers();
  });

  it('reconnects after the server retry, sending the last id from an id-only heartbeat', async () => {
    mockExecute
      .mockResolvedValueOnce(streamResponse(['retry: 2500\nid: 1\ndata: a\n\n', 'id: 2\n\n']))
      .mockResolvedValue(streamResponse([]));
    sseManager.connect(id, URL_, { 'X-A': '1' });
    await vi.advanceTimersByTimeAsync(0);

    expect(conn(id).status).toBe('reconnecting');
    expect(conn(id).lastEventId).toBe('2');
    expect(conn(id).reconnectAttempts).toBe(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2499);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(sentHeaders(1)).toMatchObject({ 'X-A': '1', 'Last-Event-ID': '2' });
  });

  it('sends no Last-Event-ID after an empty id reset', async () => {
    mockExecute
      .mockResolvedValueOnce(streamResponse(['id: 1\ndata: a\n\nid:\n\n']))
      .mockResolvedValue(streamResponse([]));
    sseManager.connect(id, URL_);
    await vi.advanceTimersByTimeAsync(0);
    expect(conn(id).lastEventId).toBe('');
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(sentHeaders(1)).not.toHaveProperty('Last-Event-ID');
  });

  it.each([
    ['204', { status: 204 }],
    ['a wrong content type', { contentType: 'application/json' }],
  ])('does not reconnect after %s', async (_label, init) => {
    mockExecute.mockResolvedValue(streamResponse(['data: a\n\n'], init));
    sseManager.connect(id, URL_);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(conn(id).status).toBe('disconnected');
  });

  it('does not reconnect after a non-2xx reply', async () => {
    mockExecute
      .mockResolvedValueOnce(streamResponse(['data: a\n\n']))
      .mockResolvedValue(streamResponse([], { status: 503 }));
    sseManager.connect(id, URL_);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockExecute).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(conn(id).status).toBe('disconnected');
    expect(messages(id)).toContain('HTTP 503 OK');
  });

  it('keeps retrying connect-phase network errors once armed, then gives up at the cap', async () => {
    mockExecute
      .mockResolvedValueOnce(streamResponse(['data: a\n\n']))
      .mockRejectedValue(new TypeError('Failed to fetch'));
    sseManager.connect(id, URL_);
    await vi.advanceTimersByTimeAsync(20_000);
    // 1 initial + 5 (default maxReconnectAttempts) reconnects
    expect(mockExecute).toHaveBeenCalledTimes(6);
    expect(conn(id).status).toBe('disconnected');
    expect(messages(id)).toContain('Gave up after 5 reconnect attempts');
  });

  it('does not reconnect when the first connect never opened', async () => {
    mockExecute.mockRejectedValue(new TypeError('Failed to fetch'));
    sseManager.connect(id, URL_);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(conn(id).status).toBe('disconnected');
  });

  it('user disconnect cancels a pending reconnect', async () => {
    mockExecute.mockResolvedValue(streamResponse(['data: a\n\n']));
    sseManager.connect(id, URL_);
    await vi.advanceTimersByTimeAsync(0);
    expect(conn(id).status).toBe('reconnecting');
    sseManager.disconnect(id);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(conn(id).status).toBe('disconnected');
  });

  it('honours the auto-reconnect toggle', async () => {
    mockExecute.mockResolvedValue(streamResponse(['data: a\n\n']));
    sseManager.connect(id, URL_, {}, { autoReconnect: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(conn(id).status).toBe('disconnected');
  });
});

describe('sseManager auto-reconnect (Electron)', () => {
  type Listener = (payload?: unknown) => void;
  let id: string;
  let listeners: Map<string, Listener>;
  let connect: ReturnType<typeof vi.fn>;
  let disconnect: ReturnType<typeof vi.fn>;
  const emit = (ch: string, payload?: unknown) => listeners.get(`${ch}:${id}`)?.(payload);

  beforeEach(() => {
    vi.useFakeTimers();
    listeners = new Map();
    connect = vi.fn(async () => ({ success: true }));
    disconnect = vi.fn(async () => ({ success: true }));
    platform.electron = true;
    platform.api = {
      sse: {
        connect,
        disconnect,
        on: (ch: string, cb: Listener) => listeners.set(ch, cb),
        removeListener: vi.fn(),
        removeAllListeners: (ch: string) => listeners.delete(ch),
      },
    };
    id = useSseStore.getState().createConnection();
  });
  afterEach(() => {
    sseManager.cleanup();
    vi.useRealTimers();
  });

  it('reconnects from the close payload stream state', async () => {
    sseManager.connect(id, URL_);
    emit('sse:open');
    emit('sse:event', { event: 'message', data: 'a', lastEventId: '1' });
    emit('sse:close', { reason: 'stream ended', lastEventId: '7', retry: 300 });
    expect(conn(id).status).toBe('reconnecting');
    expect(conn(id).lastEventId).toBe('7');
    await vi.advanceTimersByTimeAsync(300);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[1]?.[0]).toMatchObject({ headers: { 'Last-Event-ID': '7' } });
  });

  it('does not reconnect after a fatal close', async () => {
    sseManager.connect(id, URL_);
    emit('sse:open');
    emit('sse:close', { reason: 'HTTP 404', fatal: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(conn(id).status).toBe('disconnected');
  });

  it('a disconnect while still connecting reaches main', () => {
    sseManager.connect(id, URL_);
    sseManager.disconnect(id);
    expect(disconnect).toHaveBeenCalledWith({ connectionId: id });
  });

  it('a failed connect reply without a close event ends the attempt', async () => {
    connect.mockResolvedValueOnce({ success: false, error: 'Rate limit exceeded' });
    sseManager.connect(id, URL_);
    await vi.advanceTimersByTimeAsync(0);
    expect(conn(id).status).toBe('disconnected');
    expect(messages(id)).toContain('Failed to connect: Rate limit exceeded');
  });
});
