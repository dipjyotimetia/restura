// @vitest-environment node
//
// Behavioural wiring for the SSE handler: it drives the shared streaming HTTP
// proxy and translates the parsed event stream into targeted IPC emissions. We
// mock the proxy/transport and assert open → event → close emission, the HTTP
// error path, SSRF rejection, rate limiting, and explicit disconnect.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockExec, mockEmitTo, mockResolve } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockEmitTo: vi.fn(),
  mockResolve: vi.fn(),
}));

import { createElectronMock, trustedEvent, getRegisteredHandler } from './helpers/electron-mock';

vi.mock('electron', () => createElectronMock());
vi.mock('@shared/protocol/http-proxy', () => ({ executeHttpProxyStreaming: mockExec }));
vi.mock('../ipc-utils', () => ({ emitTo: mockEmitTo, errorMessage: (e: unknown) => String(e) }));
vi.mock('../connection-cleanup', () => ({ bindRendererCleanup: vi.fn(), disposeByOwner: vi.fn() }));
vi.mock('../safe-connect', () => ({
  resolveSafeAddress: mockResolve,
  createPinnedFetch: vi.fn(() => vi.fn()),
}));
vi.mock('../fetch-fetcher', () => ({ makeFetchFetcher: vi.fn(() => vi.fn()) }));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/channels';
import { registerSseHandlerIPC, stopSseCleanup, sseRateLimiter } from '../sse-handler';

type Handler = (e: unknown, p: unknown) => Promise<{ success: boolean; error?: string }>;
const connect = () => getRegisteredHandler(ipcMain, IPC.sse.connect) as Handler;

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

const okResponse = (body: ReadableStream<Uint8Array> | null, status = 200) => ({
  ok: true,
  response: { status, statusText: status === 200 ? 'OK' : 'ERR', body },
});

describe('sse-handler', () => {
  beforeEach(() => {
    mockExec.mockReset();
    mockEmitTo.mockClear();
    mockResolve.mockReset().mockResolvedValue({ host: 'h', ip: '1.2.3.4', port: 443, family: 4 });
    vi.mocked(ipcMain.handle).mockClear();
    stopSseCleanup();
    sseRateLimiter.dispose(1);
    registerSseHandlerIPC();
  });

  it('emits open, parsed events, then close for a 200 stream', async () => {
    mockExec.mockImplementation(async () =>
      okResponse(streamOf('data: hello\n\n', 'data: world\n\n'))
    );
    const res = await connect()(trustedEvent(1), { connectionId: 'c1', url: 'https://x/stream' });
    expect(res).toEqual({ success: true });

    expect(mockEmitTo).toHaveBeenCalledWith(1, 'sse:open:c1');
    await vi.waitFor(() =>
      expect(mockEmitTo).toHaveBeenCalledWith(1, 'sse:close:c1', expect.anything())
    );

    const eventCalls = mockEmitTo.mock.calls.filter((c) => c[0] === 1 && c[1] === 'sse:event:c1');
    expect(eventCalls).toHaveLength(2);
    expect(eventCalls[0]![2]).toMatchObject({ data: 'hello' });
    expect(eventCalls[1]![2]).toMatchObject({ data: 'world' });
  });

  it('emits error + close and returns failure for a non-2xx status', async () => {
    mockExec.mockResolvedValue(okResponse(null, 500));
    const res = await connect()(trustedEvent(1), { connectionId: 'c1', url: 'https://x' });
    expect(res.success).toBe(false);
    expect(mockEmitTo).toHaveBeenCalledWith(
      1,
      'sse:error:c1',
      expect.objectContaining({ message: expect.stringContaining('500') })
    );
    expect(mockEmitTo).toHaveBeenCalledWith(1, 'sse:close:c1', expect.anything());
  });

  it('returns failure without connecting when SSRF resolution rejects', async () => {
    mockResolve.mockRejectedValue(new Error('URL rejected by SSRF policy'));
    const res = await connect()(trustedEvent(1), {
      connectionId: 'c1',
      url: 'https://169.254.169.254',
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/SSRF/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('rate-limits after the per-renderer connection budget is exhausted', async () => {
    mockExec.mockImplementation(async () => okResponse(streamOf()));
    for (let i = 0; i < 20; i++) {
      await connect()(trustedEvent(1), { connectionId: `c${i}`, url: 'https://x' });
    }
    const res = await connect()(trustedEvent(1), { connectionId: 'over', url: 'https://x' });
    expect(res).toEqual({ success: false, error: expect.stringMatching(/rate limit/i) });
  });

  it('disconnect aborts and acks success', async () => {
    const disconnect = getRegisteredHandler(ipcMain, IPC.sse.disconnect) as Handler;
    mockExec.mockImplementation(async () => okResponse(streamOf('data: x\n\n')));
    await connect()(trustedEvent(1), { connectionId: 'c1', url: 'https://x' });
    const res = await disconnect(trustedEvent(1), { connectionId: 'c1' });
    expect(res).toEqual({ success: true });
  });
});
