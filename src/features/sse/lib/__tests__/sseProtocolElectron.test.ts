import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SseRequest } from '@/types';

// The web-only proxy transport must never be touched on the Electron path —
// `executeProxiedStreamingRequest` throws unconditionally under Electron
// (see src/lib/shared/transport.ts), which is exactly the bug this test
// guards against regressing: sseSubscribe workflow nodes must route through
// the `sse:connect` IPC channel instead.
const mockExecuteProxiedStreamingRequest = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shared/transport', () => ({
  executeProxiedStreamingRequest: mockExecuteProxiedStreamingRequest,
}));

vi.mock('@/lib/shared/platform', () => ({
  isElectron: () => true,
  getElectronAPI: vi.fn(),
}));

import { getElectronAPI } from '@/lib/shared/platform';
import { sseProtocol } from '../../protocol';

type Listener = (payload?: unknown) => void;

function installFakeSseApi() {
  const listeners = new Map<string, Listener>();
  const connect = vi.fn(
    async (_config: { connectionId: string; url: string; headers?: Record<string, string> }) =>
      ({ success: true }) as { success: boolean; error?: string }
  );
  const disconnect = vi.fn(async () => ({ success: true }));
  const sse = {
    connect,
    disconnect,
    on: vi.fn((channel: string, cb: Listener) => {
      listeners.set(channel, cb);
    }),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn((channel: string) => {
      listeners.delete(channel);
    }),
  };
  vi.mocked(getElectronAPI).mockReturnValue({ sse } as never);
  return {
    sse,
    connect,
    disconnect,
    emit: (channel: string, payload?: unknown) => listeners.get(channel)?.(payload),
  };
}

function baseRequest(overrides: Partial<SseRequest> = {}): SseRequest {
  return {
    id: 'r1',
    name: 'sse',
    type: 'sse',
    url: 'https://example.com/stream',
    headers: [],
    params: [],
    auth: { type: 'none' },
    reconnectOnResume: true,
    ...overrides,
  } as SseRequest;
}

describe('sseProtocol.startStream on Electron', () => {
  beforeEach(() => {
    mockExecuteProxiedStreamingRequest.mockReset();
  });

  it('connects via the sse:connect IPC channel, never the proxy transport', async () => {
    const api = installFakeSseApi();
    const handle = await sseProtocol.startStream!(baseRequest(), {
      signal: new AbortController().signal,
      variables: {},
    });

    expect(api.connect).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com/stream' })
    );
    expect(mockExecuteProxiedStreamingRequest).not.toHaveBeenCalled();

    await handle.close();
    expect(api.disconnect).toHaveBeenCalled();
  });

  it('yields events delivered over the sse:event IPC channel', async () => {
    const api = installFakeSseApi();
    const handle = await sseProtocol.startStream!(baseRequest(), {
      signal: new AbortController().signal,
      variables: {},
    });

    const firstCall = api.connect.mock.calls[0];
    const connectionId = firstCall![0].connectionId;
    const iterator = handle.events[Symbol.asyncIterator]();
    const next = iterator.next();
    api.emit(`sse:event:${connectionId}`, { event: 'message', data: 'hello' });

    const result = await next;
    expect(result.value).toEqual({ event: 'message', data: 'hello' });

    api.emit(`sse:close:${connectionId}`);
    const done = await iterator.next();
    expect(done.done).toBe(true);
  });

  it('throws when the IPC connect call reports failure', async () => {
    const api = installFakeSseApi();
    api.connect.mockResolvedValueOnce({ success: false, error: 'blocked by SSRF policy' });

    await expect(
      sseProtocol.startStream!(baseRequest(), {
        signal: new AbortController().signal,
        variables: {},
      })
    ).rejects.toThrow('blocked by SSRF policy');
  });

  it('disconnects when the caller aborts mid-stream', async () => {
    const api = installFakeSseApi();
    const controller = new AbortController();
    await sseProtocol.startStream!(baseRequest(), { signal: controller.signal, variables: {} });

    controller.abort();
    expect(api.disconnect).toHaveBeenCalled();
  });
});
