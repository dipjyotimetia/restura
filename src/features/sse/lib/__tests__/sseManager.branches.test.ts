import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecute = vi.hoisted(() => vi.fn());
const platform = vi.hoisted(() => ({ electron: false, api: undefined as unknown }));
vi.mock('@/lib/shared/transport', () => ({ executeProxiedStreamingRequest: mockExecute }));
vi.mock('@/lib/shared/platform', () => ({
  isElectron: () => platform.electron,
  getElectronAPI: () => platform.api,
}));

import { useSseStore } from '@/features/sse/store/useSseStore';
import { buildSseStreamSpec, sseManager } from '../sseManager';

const URL_ = 'https://example.com/stream';
const enc = new TextEncoder();

interface FakeInit {
  status?: number;
  statusText?: string;
  contentType?: string;
  proxyGenerated?: boolean;
  noBody?: boolean;
  cancelRejects?: boolean;
  /** Called for each read; return a chunk, 'end', or throw. */
  readImpl?: () => Promise<{ done: boolean; value?: Uint8Array }>;
}

function response(chunks: string[], init: FakeInit = {}): Response {
  let i = 0;
  const status = init.status ?? 200;
  const cancel = vi.fn(async () => {
    if (init.cancelRejects) throw new Error('cancel failed');
  });
  const body = init.noBody
    ? null
    : {
        getReader: () => ({
          read:
            init.readImpl ??
            (async () =>
              i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true }),
        }),
        cancel,
      };
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init.statusText ?? 'OK',
    headers: new Headers({
      'content-type': init.contentType ?? 'text/event-stream',
      ...(init.proxyGenerated ? {} : { 'x-restura-proxy-stream': '1' }),
    }),
    body,
  } as unknown as Response;
}

const conn = (id: string) => useSseStore.getState().connections[id]!;
const messages = (id: string) =>
  conn(id)
    .log.filter((e) => e.kind === 'system')
    .map((e) => (e as { message: string }).message);

describe('sseManager helpers', () => {
  it('builds the streaming proxy spec with the orchestrator timeout disabled', () => {
    expect(buildSseStreamSpec('https://x', { A: 'b' })).toEqual({
      method: 'GET',
      url: 'https://x',
      headers: { A: 'b' },
      streamingMode: true,
      timeout: 0,
    });
  });
});

describe('sseManager (web)', () => {
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

  it.each([
    ['', 'URL is required'],
    ['   ', 'URL is required'],
    ['ftp://example.com/x', 'Invalid protocol "ftp:"'],
    ['not a url', 'Invalid URL format'],
  ])('rejects the URL %j without connecting', (url, expected) => {
    sseManager.connect(id, url);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(conn(id).status).toBe('disconnected');
    expect(messages(id)[0]).toContain(expected);
  });

  it('streams events, tracks open state and reports a clean close', async () => {
    mockExecute.mockResolvedValue(
      response(['retry: 50\nid: 1\nevent: tick\ndata: a\n\n'], { contentType: 'text/plain' })
    );
    sseManager.connect(id, URL_, { 'X-A': '1' }, { autoReconnect: false });
    expect(conn(id).status).toBe('connecting');
    await vi.advanceTimersByTimeAsync(0);
    const log = conn(id).log;
    expect(log.some((e) => e.kind === 'event' && e.event === 'tick' && e.retry === 50)).toBe(true);
    expect(conn(id).lastConnectedAt).toBeTypeOf('number');
    expect(messages(id)).toEqual(expect.arrayContaining([`Connected to ${URL_}`, 'Stream closed']));
    expect(mockExecute.mock.calls[0]?.[0].headers).toMatchObject({
      Accept: 'text/event-stream',
      'X-A': '1',
    });
    expect(conn(id).status).toBe('disconnected');
  });

  it('isConnected reflects a live web connection and clears after disconnect', async () => {
    mockExecute.mockReturnValue(new Promise(() => undefined));
    sseManager.connect(id, URL_);
    expect(sseManager.isConnected(id)).toBe(true);
    sseManager.disconnect(id);
    expect(sseManager.isConnected(id)).toBe(false);
    // Disconnecting something unknown is harmless and leaves status alone.
    sseManager.disconnect('unknown');
  });

  it('a failed HTTP reply cancels the body, tolerating cancel errors', async () => {
    mockExecute.mockResolvedValue(
      response([], { status: 404, statusText: 'Not Found', cancelRejects: true })
    );
    sseManager.connect(id, URL_);
    await vi.advanceTimersByTimeAsync(0);
    expect(messages(id)).toContain('HTTP 404 Not Found');
    expect(conn(id).status).toBe('disconnected');
  });

  it('a failed HTTP reply without a body still ends the attempt', async () => {
    mockExecute.mockResolvedValue(response([], { status: 500, noBody: true }));
    sseManager.connect(id, URL_);
    await vi.advanceTimersByTimeAsync(0);
    expect(messages(id)).toContain('HTTP 500 OK');
  });

  it('a 2xx reply with no body is fatal', async () => {
    mockExecute.mockResolvedValue(response([], { noBody: true }));
    sseManager.connect(id, URL_);
    await vi.advanceTimersByTimeAsync(0);
    expect(messages(id)).toContain('No response body');
    expect(conn(id).status).toBe('disconnected');
  });

  it('retries a read error once the stream has opened, reporting the message', async () => {
    mockExecute
      .mockResolvedValueOnce(
        response([], {
          readImpl: async () => {
            throw new Error('socket reset');
          },
        })
      )
      .mockResolvedValue(response([]));
    sseManager.connect(id, URL_);
    await vi.advanceTimersByTimeAsync(0);
    expect(messages(id)).toContain('Stream error: socket reset');
    expect(conn(id).status).toBe('reconnecting');
    expect(messages(id).some((m) => m.startsWith('Reconnecting in 1000 ms (attempt 1/5)'))).toBe(
      true
    );
  });

  it('reports a non-Error rejection as Unknown', async () => {
    mockExecute.mockRejectedValue('weird');
    sseManager.connect(id, URL_);
    await vi.advanceTimersByTimeAsync(0);
    expect(messages(id)).toContain('Stream error: Unknown');
  });

  it('times out a connect that never answers', async () => {
    mockExecute.mockImplementation(
      (_spec: unknown, opts: { signal: AbortSignal }) =>
        new Promise((_res, rej) => {
          opts.signal.addEventListener('abort', () => rej(new Error('aborted')));
        })
    );
    sseManager.connect(id, URL_);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(messages(id)).toContain('Stream aborted: connection timed out');
    expect(conn(id).status).toBe('disconnected');
  });

  it('notes an aborted stream when the user disconnects mid-flight', async () => {
    mockExecute.mockImplementation(
      (_spec: unknown, opts: { signal: AbortSignal }) =>
        new Promise((_res, rej) => {
          opts.signal.addEventListener('abort', () => rej(new Error('aborted')));
        })
    );
    sseManager.connect(id, URL_);
    sseManager.disconnect(id);
    await vi.advanceTimersByTimeAsync(0);
    expect(messages(id)).toContain('Stream aborted');
    expect(conn(id).status).toBe('disconnected');
    expect(conn(id).reconnectAttempts).toBe(0);
  });

  it('a superseded attempt notes the abort but never reports a stream error', async () => {
    let rejectFirst: (e: unknown) => void = () => undefined;
    mockExecute
      .mockReturnValueOnce(new Promise((_r, rej) => (rejectFirst = rej)))
      .mockReturnValue(new Promise(() => undefined));
    sseManager.connect(id, URL_);
    sseManager.connect(id, URL_);
    rejectFirst(new Error('late'));
    await vi.advanceTimersByTimeAsync(0);
    expect(messages(id)).toContain('Stream aborted');
    expect(messages(id).some((m) => m.startsWith('Stream error'))).toBe(false);
  });

  it('ignores events from a superseded attempt', async () => {
    let releaseRead: () => void = () => undefined;
    mockExecute
      .mockResolvedValueOnce(
        response([], {
          readImpl: () =>
            new Promise((res) => {
              releaseRead = () => res({ done: false, value: enc.encode('data: stale\n\n') });
            }),
        })
      )
      .mockReturnValue(new Promise(() => undefined));
    sseManager.connect(id, URL_);
    await vi.advanceTimersByTimeAsync(0);
    sseManager.connect(id, URL_);
    releaseRead();
    await vi.advanceTimersByTimeAsync(0);
    expect(conn(id).log.some((e) => e.kind === 'event')).toBe(false);
  });

  it('honours a custom reconnection delay and the reconnect-on-resume toggle', async () => {
    useSseStore.setState((s) => ({
      connections: { ...s.connections, [id]: { ...s.connections[id]!, reconnectDelay: 300 } },
    }));
    mockExecute.mockResolvedValue(response(['id: 4\ndata: a\n\n']));
    sseManager.connect(id, URL_, undefined, { reconnectOnResume: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(messages(id).some((m) => m.startsWith('Reconnecting in 300 ms'))).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(mockExecute.mock.calls[1]?.[0].headers).not.toHaveProperty('Last-Event-ID');
  });

  it('cleanup disconnects every tracked stream', async () => {
    const other = useSseStore.getState().createConnection();
    mockExecute.mockReturnValue(new Promise(() => undefined));
    sseManager.connect(id, URL_);
    sseManager.connect(other, URL_);
    sseManager.cleanup();
    expect(sseManager.isConnected(id)).toBe(false);
    expect(sseManager.isConnected(other)).toBe(false);
    expect(conn(other).status).toBe('disconnected');
  });

  it('a stale reconnect timer does nothing once the session was replaced', async () => {
    mockExecute
      .mockResolvedValueOnce(response(['data: a\n\n']))
      .mockReturnValue(new Promise(() => undefined));
    sseManager.connect(id, URL_);
    await vi.advanceTimersByTimeAsync(0);
    expect(conn(id).status).toBe('reconnecting');
    sseManager.connect(id, URL_);
    await vi.advanceTimersByTimeAsync(5000);
    // Initial + the new connect; the cancelled timer never fired a third.
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });
});

describe('sseManager (Electron)', () => {
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
    platform.electron = false;
  });

  it('fails fatally when the SSE bridge is missing', () => {
    platform.api = {};
    sseManager.connect(id, URL_);
    expect(messages(id)).toContain('Electron SSE API not available');
    expect(conn(id).status).toBe('disconnected');
  });

  it('tracks open state through isConnected and logs error events', () => {
    sseManager.connect(id, URL_);
    expect(sseManager.isConnected(id)).toBe(false);
    emit('sse:open');
    expect(sseManager.isConnected(id)).toBe(true);
    emit('sse:error', { message: 'boom' });
    expect(messages(id)).toContain('Error: boom');
    expect(conn(id).status).toBe('connected');
  });

  it('records event retry and last-event-id from forwarded events', () => {
    sseManager.connect(id, URL_);
    emit('sse:open');
    emit('sse:event', { event: 'm', data: 'x', lastEventId: '3', retry: 40 });
    expect(conn(id).lastEventId).toBe('3');
    emit('sse:close', {});
    expect(messages(id).some((m) => m.startsWith('Reconnecting in 40 ms'))).toBe(true);
  });

  it('closes without a reason or payload fields and reconnects', async () => {
    sseManager.connect(id, URL_);
    emit('sse:open');
    emit('sse:close', {});
    expect(messages(id)).toContain('Stream closed');
    expect(conn(id).status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('stops reconnecting and reports the final failure of a rejected connect', async () => {
    connect.mockRejectedValueOnce(new Error('ipc broke'));
    sseManager.connect(id, URL_);
    await vi.advanceTimersByTimeAsync(0);
    expect(messages(id)).toContain('Failed to connect: ipc broke');
    expect(conn(id).status).toBe('disconnected');
  });

  it('uses a default message for a non-Error connect rejection', async () => {
    connect.mockRejectedValueOnce('x');
    sseManager.connect(id, URL_);
    await vi.advanceTimersByTimeAsync(0);
    expect(messages(id)).toContain('Failed to connect: Connection failed');
  });

  it('reports an unknown error when the failed reply carries none', async () => {
    connect.mockResolvedValueOnce({ success: false });
    sseManager.connect(id, URL_);
    await vi.advanceTimersByTimeAsync(0);
    expect(messages(id)).toContain('Failed to connect: unknown error');
  });

  it('ignores error events and replies once the user disconnected', async () => {
    let resolveConnect: (v: { success: boolean; error?: string }) => void = () => undefined;
    connect.mockReturnValueOnce(new Promise((r) => (resolveConnect = r)));
    sseManager.connect(id, URL_);
    const handler = listeners.get(`sse:error:${id}`);
    sseManager.disconnect(id);
    handler?.({ message: 'late' });
    resolveConnect({ success: false, error: 'late' });
    await vi.advanceTimersByTimeAsync(0);
    expect(messages(id)).not.toContain('Error: late');
    expect(disconnect).toHaveBeenCalledWith({ connectionId: id });
  });
});
