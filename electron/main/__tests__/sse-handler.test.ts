import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const mockResolveSafe = vi.hoisted(() =>
  vi.fn(async () => ({ host: 'example.com', ip: '203.0.113.1', port: 443, family: 4 as const }))
);
const mockStreaming = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({ ipcMain: { handle: mockHandle } }));
vi.mock('../ipc/ipc-utils', () => ({ emitTo: mockEmitTo }));
vi.mock('../ipc/ipc-rate-limiter', () => ({
  createKeyedRateLimiter: () => ({ check: () => true }),
}));
vi.mock('../security/safe-connect', () => ({
  resolveSafeAddress: mockResolveSafe,
  createPinnedFetch: () => vi.fn(),
}));
// Validators reduced to passthrough so the test drives the handler logic directly.
vi.mock('../ipc/ipc-validators', () => ({
  SseConnectSchema: {},
  SseDisconnectSchema: {},
  validateIpcInput: (_s: unknown, raw: unknown) => raw,
  createValidatedHandler:
    (_c: unknown, _s: unknown, fn: (cfg: unknown) => unknown) => (_e: unknown, raw: unknown) =>
      fn(raw),
  assertTrustedSender: () => {},
}));
vi.mock('@shared/protocol/http-proxy', () => ({ executeHttpProxyStreaming: mockStreaming }));

import { registerSseHandlerIPC, stopSseCleanup } from '../handlers/sse-handler';

function handlerFor(channel: string) {
  const call = mockHandle.mock.calls.find((c) => c[0] === channel);
  return call?.[1] as (e: unknown, p: unknown) => Promise<{ success: boolean; error?: string }>;
}

/** Build a fake renderer event whose sender records its 'destroyed' listener. */
function makeEvent(id: number) {
  const listeners: Array<() => void> = [];
  return {
    event: {
      sender: {
        id,
        isDestroyed: () => false,
        once: (_e: string, cb: () => void) => listeners.push(cb),
      },
    },
    destroy: () => listeners.splice(0).forEach((cb) => cb()),
  };
}

/** A one-shot SSE body that emits a single `data:` frame then closes. */
function singleEventBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: hello\n\n'));
      controller.close();
    },
  });
}

const flush = () => new Promise((r) => setTimeout(r, 5));

describe('sse-handler (StreamRegistry-backed)', () => {
  beforeEach(() => {
    mockHandle.mockClear();
    mockEmitTo.mockClear();
    mockResolveSafe.mockClear();
    mockStreaming.mockReset();
    registerSseHandlerIPC();
  });
  afterEach(() => stopSseCleanup());

  it('emits open → event → close over the connection lifecycle', async () => {
    mockStreaming.mockResolvedValue({
      ok: true,
      response: { status: 200, statusText: 'OK', body: singleEventBody() },
    });
    const { event } = makeEvent(7);
    const res = await handlerFor('sse:connect')(event, {
      connectionId: 'c1',
      url: 'https://example.com/stream',
    });
    expect(res.success).toBe(true);
    expect(mockResolveSafe).toHaveBeenCalledWith('https://example.com/stream', {
      allowLocalhost: true,
      allowPrivateIPs: false,
    });
    await flush();
    const channels = mockEmitTo.mock.calls.map((c) => c[1]);
    expect(channels).toContain('sse:open:c1');
    expect(channels).toContain('sse:event:c1');
    expect(channels).toContain('sse:close:c1');
  });

  it('propagates an upstream error as error + close', async () => {
    mockStreaming.mockResolvedValue({ ok: false, status: 502, payload: { error: 'bad upstream' } });
    const { event } = makeEvent(7);
    const res = await handlerFor('sse:connect')(event, { connectionId: 'c2', url: 'https://x' });
    expect(res.success).toBe(false);
    const errCall = mockEmitTo.mock.calls.find((c) => c[1] === 'sse:error:c2');
    expect(errCall?.[2]).toEqual({ message: 'bad upstream' });
    expect(mockEmitTo.mock.calls.some((c) => c[1] === 'sse:close:c2')).toBe(true);
  });

  it('disconnect suppresses the trailing close event (explicitlyClosed)', async () => {
    // A body that never closes, so the only close would come from disconnect.
    mockStreaming.mockResolvedValue({
      ok: true,
      response: { status: 200, statusText: 'OK', body: new ReadableStream({ start() {} }) },
    });
    const { event } = makeEvent(7);
    await handlerFor('sse:connect')(event, { connectionId: 'c3', url: 'https://x' });
    await flush();
    mockEmitTo.mockClear();
    await handlerFor('sse:disconnect')(event, { connectionId: 'c3' });
    await flush();
    // explicitlyClosed ⇒ no close event emitted for an explicit disconnect.
    expect(mockEmitTo.mock.calls.some((c) => c[1] === 'sse:close:c3')).toBe(false);
  });

  it('tears down a connection when its renderer is destroyed', async () => {
    mockStreaming.mockResolvedValue({
      ok: true,
      response: { status: 200, statusText: 'OK', body: new ReadableStream({ start() {} }) },
    });
    const { event, destroy } = makeEvent(9);
    await handlerFor('sse:connect')(event, { connectionId: 'c4', url: 'https://x' });
    await flush();
    expect(() => destroy()).not.toThrow();
    // After destroy the connection is gone; a subsequent disconnect is a no-op success.
    const res = await handlerFor('sse:disconnect')(event, { connectionId: 'c4' });
    expect(res.success).toBe(true);
  });
});
