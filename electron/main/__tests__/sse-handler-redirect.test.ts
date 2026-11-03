// @vitest-environment node
//
// Plain SSE follows redirects on desktop like the Worker does, without
// mocking the shared streaming core: every hop goes through the DNS guard
// (resolveSafeAddress) and is dialled on a connection pinned to that hop's
// validated address. Only the network edge (DNS + pinned dial) is faked, and
// the fake dial refuses any hostname other than the pinned one — exactly
// what the real createPinnedLookup does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const ADDRESSES: Record<string, string> = {
  'api.example.com': '203.0.113.7',
  'stream.example-cdn.com': '198.51.100.9',
};
const mockResolveSafe = vi.hoisted(() =>
  vi.fn(async (url: string, _opts: unknown) => {
    const host = new URL(url).hostname;
    const ip = ADDRESSES[host];
    if (!ip) throw new Error(`DNS guard rejected ${host}`);
    return { host, ip, port: 443, family: 4 as const };
  })
);
const dialled = vi.hoisted((): Array<{ url: string; pinnedTo: string }> => []);
const upstream = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Response>());
/** Hostnames whose pinned Agent was closed, in close order. */
const closedAgents = vi.hoisted((): string[] => []);

vi.mock('electron', () => ({ ipcMain: { handle: mockHandle, removeHandler: vi.fn() } }));
vi.mock('../ipc/ipc-utils', () => ({ emitTo: mockEmitTo }));
vi.mock('../security/safe-connect', () => {
  const pinnedFetch =
    (host: string, ip: string) =>
    async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const hostname = new URL(url).hostname;
      if (hostname !== host) {
        throw new Error(
          `pinned lookup refused unexpected hostname "${hostname}" (pinned to "${host}")`
        );
      }
      expect(init?.redirect).toBe('manual');
      dialled.push({ url, pinnedTo: ip });
      return upstream(url, init);
    };
  return {
    resolveSafeAddress: mockResolveSafe,
    createPinnedFetch: pinnedFetch,
    createClosablePinnedFetch: (host: string, ip: string) => ({
      fetch: pinnedFetch(host, ip),
      close: async () => {
        closedAgents.push(host);
      },
    }),
  };
});

import { IPC } from '../../shared/channels';
import { registerSseHandlerIPC, stopSseCleanup } from '../handlers/sse-handler';
import { setExecutionPolicy } from '../security/execution-policy';

type Reply = { success: boolean; error?: string };
const connect = (payload: unknown) => {
  const handler = mockHandle.mock.calls.find((c) => c[0] === IPC.sse.connect)?.[1] as (
    e: unknown,
    p: unknown
  ) => Promise<Reply>;
  return handler(
    {
      sender: { id: 4242, isDestroyed: () => false, once: () => {} },
      senderFrame: { url: 'file:///app/dist/web/index.html', parent: null },
    },
    payload
  );
};

const flush = () => new Promise((r) => setTimeout(r, 5));
const eventStream = () =>
  new Response('data: hello\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });

describe('sse:connect — redirects on desktop', () => {
  beforeEach(() => {
    setExecutionPolicy({
      security: { allowLocalhost: false, allowPrivateIPs: false },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    mockHandle.mockClear();
    mockEmitTo.mockClear();
    mockResolveSafe.mockClear();
    upstream.mockReset();
    dialled.length = 0;
    closedAgents.length = 0;
    registerSseHandlerIPC();
  });
  afterEach(() => stopSseCleanup());

  it('follows a cross-host 302 and re-pins the second host through the DNS guard', async () => {
    upstream.mockImplementation((url) =>
      url.startsWith('https://api.example.com/')
        ? new Response(null, {
            status: 302,
            headers: { Location: 'https://stream.example-cdn.com/events?t=1' },
          })
        : eventStream()
    );

    const res = await connect({ connectionId: 'r1', url: 'https://api.example.com/events' });

    expect(res).toEqual({ success: true });
    expect(mockResolveSafe.mock.calls.map((c) => c[0])).toEqual([
      'https://api.example.com/events',
      'https://stream.example-cdn.com/events?t=1',
    ]);
    expect(dialled).toEqual([
      { url: 'https://api.example.com/events', pinnedTo: '203.0.113.7' },
      { url: 'https://stream.example-cdn.com/events?t=1', pinnedTo: '198.51.100.9' },
    ]);
    await flush();
    expect(mockEmitTo.mock.calls.map((c) => c[1])).toContain('sse:event:r1');
  });

  it('fails the connect when the redirect target is rejected by the DNS guard', async () => {
    upstream.mockImplementation(
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'https://internal.corp.example/events' },
        })
    );

    const res = await connect({ connectionId: 'r2', url: 'https://api.example.com/events' });

    expect(res.success).toBe(false);
    expect(res.error).toContain('DNS guard rejected internal.corp.example');
    expect(dialled.map((d) => d.url)).toEqual(['https://api.example.com/events']);
  });

  it('closes every per-origin Agent once the stream ends', async () => {
    upstream.mockImplementation((url) =>
      url.startsWith('https://api.example.com/')
        ? new Response(null, {
            status: 302,
            headers: { Location: 'https://stream.example-cdn.com/events?t=1' },
          })
        : eventStream()
    );
    const res = await connect({ connectionId: 'r3', url: 'https://api.example.com/events' });
    expect(res).toEqual({ success: true });
    await flush();
    expect(closedAgents.sort()).toEqual(['api.example.com', 'stream.example-cdn.com']);
  });

  it('closes the Agent when the connect fails', async () => {
    upstream.mockImplementation(
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'https://internal.corp.example/events' },
        })
    );
    const res = await connect({ connectionId: 'r4', url: 'https://api.example.com/events' });
    expect(res.success).toBe(false);
    expect(closedAgents).toEqual(['api.example.com']);
  });

  it('closes the Agent when a live stream is aborted by disconnect', async () => {
    // Like undici, aborting the request errors the open body.
    upstream.mockImplementation(
      (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              init?.signal?.addEventListener('abort', () => c.error(new Error('aborted')));
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        )
    );
    const res = await connect({ connectionId: 'r5', url: 'https://api.example.com/events' });
    expect(res).toEqual({ success: true });
    await flush();
    expect(closedAgents).toEqual([]);
    stopSseCleanup();
    await flush();
    expect(closedAgents).toEqual(['api.example.com']);
  });
});
