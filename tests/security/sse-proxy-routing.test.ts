/**
 * SSE proxy routing regression.
 *
 * Asserts that in web mode every SSE connection attempt routes through
 * `/api/proxy` (the Worker proxy), never directly to the upstream URL.
 * Two paths must hold:
 *
 *   - `sseManager.connect(...)` for the interactive SseClient (both
 *     custom-header and no-header variants — previously the no-header
 *     case used native `EventSource(upstreamUrl)` and the custom-header
 *     case used `fetch(upstreamUrl)`, both bypassing SSRF/header policy).
 *   - `sseProtocol.startStream(...)` for the DAG executor's
 *     `sseSubscribe` node (previously raw `fetch(upstreamUrl)`).
 *
 * The renderer SSRF guard is best-effort; the Worker is the chokepoint.
 * Without this gate, any user-supplied SSE URL hits the upstream
 * directly from the browser, evading the metadata-IP / link-local /
 * RFC1918 checks enforced by `shared/protocol/url-validation`.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sseManager } from '@/features/sse/lib/sseManager';
import { sseProtocol } from '@/features/sse/protocol';
import { useSseStore } from '@/features/sse/store/useSseStore';

const UPSTREAM = 'https://upstream.example.com/events';

interface FakeReader {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel: () => Promise<void>;
}

function makeEmptyStreamResponse(): Response {
  const reader: FakeReader = {
    read: async () => ({ done: true }),
    cancel: async () => undefined,
  };
  const body = {
    getReader: () => reader,
  } as unknown as ReadableStream<Uint8Array>;
  // Minimal Response stand-in — sseManager / startStream only touch
  // `ok`, `status`, `statusText`, `body`.
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body,
    text: async () => '',
    json: async () => ({}),
  } as unknown as Response;
}

function isProxiedUrl(input: string): boolean {
  try {
    // Relative URLs (e.g. `/api/proxy`) — pathname starts with /api.
    if (input.startsWith('/')) return input.startsWith('/api/');
    const u = new URL(input);
    return u.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

describe('SSE proxy routing (security regression)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let eventSourceSpy: ReturnType<typeof vi.fn>;
  let connectionId: string;

  beforeEach(() => {
    fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      makeEmptyStreamResponse()
    );
    // Cast through unknown to satisfy lib.dom's strict fetch type.
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // EventSource is not implemented in jsdom. Provide a counting stub so
    // we can assert "zero direct EventSource constructions" without
    // letting the legacy path crash with `ReferenceError: EventSource is
    // not defined` and mask the real assertion.
    eventSourceSpy = vi.fn();
    const captured = eventSourceSpy;
    (globalThis as unknown as { EventSource: unknown }).EventSource = class FakeEventSource {
      constructor(url: string) {
        (captured as unknown as (u: string) => void)(url);
      }
      readyState = 0;
      close() {}
      onopen: ((e: Event) => void) | null = null;
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
    };

    // Seed a connection in the store so `sseManager.connect(id, ...)` finds
    // it for lastEventId / reconnectOnResume lookups.
    const store = useSseStore.getState();
    connectionId = store.createConnection(UPSTREAM);
  });

  afterEach(() => {
    sseManager.cleanup();
    vi.restoreAllMocks();
    // Reset the SSE store between tests so connection IDs don't accumulate.
    useSseStore.setState({ connections: {}, activeConnectionId: null });
  });

  it('sseManager.connect WITHOUT custom headers routes through /api/proxy (not EventSource)', async () => {
    sseManager.connect(connectionId, UPSTREAM);

    // Let the async path (whichever it is) run through its first await.
    await Promise.resolve();
    await Promise.resolve();

    expect(eventSourceSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalled();
    for (const call of fetchSpy.mock.calls) {
      const url = String(call[0]);
      expect(isProxiedUrl(url), `expected proxied URL, saw direct call to ${url}`).toBe(true);
    }
  });

  it('sseManager.connect WITH custom headers routes through /api/proxy (not direct fetch)', async () => {
    sseManager.connect(connectionId, UPSTREAM, { Authorization: 'Bearer abc' });

    await Promise.resolve();
    await Promise.resolve();

    expect(eventSourceSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalled();
    for (const call of fetchSpy.mock.calls) {
      const url = String(call[0]);
      expect(isProxiedUrl(url), `expected proxied URL, saw direct call to ${url}`).toBe(true);
    }
  });

  it('sseProtocol.startStream routes through /api/proxy (DAG executor path)', async () => {
    const controller = new AbortController();
    try {
      const handle = await sseProtocol.startStream!(
        {
          id: 'test',
          name: 'test',
          type: 'sse',
          url: UPSTREAM,
          headers: [],
          params: [],
          auth: { type: 'none' },
          reconnectOnResume: false,
        },
        { signal: controller.signal, variables: {} }
      );
      // Tear down the iterator immediately — we only care about the
      // initial outbound request URL.
      await handle.close();
    } catch {
      // The transport may surface an error from the stub Response; that's
      // fine. The assertion below covers the URL regardless.
    }

    expect(fetchSpy).toHaveBeenCalled();
    for (const call of fetchSpy.mock.calls) {
      const url = String(call[0]);
      expect(isProxiedUrl(url), `expected proxied URL, saw direct call to ${url}`).toBe(true);
    }
    controller.abort();
  });
});
