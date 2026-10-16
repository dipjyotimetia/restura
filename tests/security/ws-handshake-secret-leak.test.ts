// @vitest-environment node
//
// GraphQL-subscription handshake secrets (#878/#882, ADR-0007) regression.
//
// `ws:connect` may carry SecretRef-handle auth and SecretRef-backed {{vars}}
// that Electron main resolves at wire time. The resolved plaintext must never
// travel back to the renderer: not in the `ws:connect` reply (success or any
// failure branch), not in emitted `ws:error` / `ws:close` events, and not in
// the main-process log line. The same holds for graphql-sse over `sse:connect`
// (reply, `sse:error` / `sse:close` / `sse:event`, logs).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'S3cr3t-Pl@in text&1';
const HOST_PART = 'tenant-from-vault';

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const mockResolveSafe = vi.hoisted(() => vi.fn());
const mockLogWarn = vi.hoisted(() => vi.fn());
const mockStreaming = vi.hoisted(() => vi.fn());

const wsMock = vi.hoisted(() => {
  class FakeWebSocket {
    static OPEN = 1;
    static instances: FakeWebSocket[] = [];
    static throwOnConstruct: Error | null = null;
    protocol = '';
    terminate = vi.fn();
    close = vi.fn();
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor(
      public url: string,
      _protocols?: unknown,
      public options?: { headers?: Record<string, string> }
    ) {
      if (FakeWebSocket.throwOnConstruct) throw FakeWebSocket.throwOnConstruct;
      FakeWebSocket.instances.push(this);
    }
    on(evt: string, cb: (...args: unknown[]) => void): this {
      this.listeners.set(evt, [...(this.listeners.get(evt) ?? []), cb]);
      return this;
    }
    fire(evt: string, ...args: unknown[]): void {
      for (const cb of this.listeners.get(evt) ?? []) cb(...args);
    }
  }
  return { FakeWebSocket };
});

vi.mock('electron', () => ({ ipcMain: { handle: mockHandle, removeHandler: vi.fn() } }));
vi.mock('ws', () => ({ default: wsMock.FakeWebSocket }));
vi.mock('@shared/runtime/logger', () => ({
  createLogger: () => ({ warn: mockLogWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../electron/main/ipc/ipc-utils', () => ({ emitTo: mockEmitTo }));
vi.mock('../../electron/main/security/safe-connect', () => ({
  resolveSafeAddress: mockResolveSafe,
  createPinnedLookup: () => vi.fn(),
  createPinnedFetch: () => vi.fn(),
}));
vi.mock('@shared/protocol/http-proxy', () => ({ executeHttpProxyStreaming: mockStreaming }));
vi.mock('../../electron/main/security/secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    const ref = v as { kind?: string; value?: string; id?: string } | undefined;
    if (ref?.kind === 'inline') return ref.value;
    if (ref?.kind === 'handle') return { 'h-secret': SECRET, 'h-host': HOST_PART }[ref.id ?? ''];
    return undefined;
  },
}));

import { registerSseHandlerIPC, stopSseCleanup } from '../../electron/main/handlers/sse-handler';
import {
  registerWebSocketHandlerIPC,
  stopWebSocketCleanup,
} from '../../electron/main/handlers/websocket-handler';
import { setExecutionPolicy } from '../../electron/main/security/execution-policy';
import { IPC } from '../../electron/shared/channels';

type Reply = { success: boolean; error?: string };
const handler = () =>
  mockHandle.mock.calls.find((c) => c[0] === IPC.ws.connect)?.[1] as (
    e: unknown,
    p: unknown
  ) => Promise<Reply>;

let senderId = 5000;
function makeEvent() {
  const id = senderId++;
  return {
    sender: { id, isDestroyed: () => false, once: vi.fn() },
    senderFrame: { url: 'file:///app/dist/web/index.html', parent: null },
  };
}

/** Every plaintext form a leak could take. */
const FORBIDDEN = [
  SECRET,
  encodeURIComponent(SECRET),
  new URLSearchParams({ v: SECRET }).toString().slice(2),
  HOST_PART,
  Buffer.from(`user:${SECRET}`).toString('base64'),
];

function assertNoPlaintext(label: string, value: unknown): void {
  const text = JSON.stringify(value);
  for (const needle of FORBIDDEN) {
    expect(text, `${label} leaked ${needle}`).not.toContain(needle);
  }
}

const secretConnect = (connectionId: string) => ({
  connectionId,
  url: 'wss://api.example.com/graphql?tenant={{tenant}}',
  headers: { 'X-Echo': 'v={{tok}}' },
  secretVariables: {
    tenant: { kind: 'handle', id: 'h-host' },
    tok: { kind: 'handle', id: 'h-secret' },
  },
  auth: {
    type: 'api-key',
    apiKey: { key: 'api_key', value: { kind: 'handle', id: 'h-secret' }, in: 'query' },
  },
});

describe('ws:connect never echoes main-resolved secrets', () => {
  beforeEach(() => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    stopWebSocketCleanup();
    mockHandle.mockClear();
    mockEmitTo.mockClear();
    mockLogWarn.mockClear();
    mockResolveSafe.mockReset();
    mockResolveSafe.mockResolvedValue({
      host: 'api.example.com',
      ip: '203.0.113.9',
      port: 443,
      family: 4,
    });
    wsMock.FakeWebSocket.instances.length = 0;
    wsMock.FakeWebSocket.throwOnConstruct = null;
    registerWebSocketHandlerIPC();
  });

  it('applies the secrets on the wire but returns only { success: true }', async () => {
    const reply = await handler()(makeEvent(), secretConnect('ok'));
    expect(reply).toEqual({ success: true });
    const ws = wsMock.FakeWebSocket.instances[0]!;
    // Sanity: the secrets really were materialized main-side.
    expect(ws.url).toContain(encodeURIComponent(HOST_PART));
    expect(ws.options?.headers?.['X-Echo']).toBe(`v=${SECRET}`);
  });

  it('redacts an SSRF/DNS failure that quotes the resolved URL', async () => {
    mockResolveSafe.mockImplementationOnce(async (url: string) => {
      throw new Error(`URL rejected by policy: ${url}`);
    });
    const reply = await handler()(makeEvent(), secretConnect('dns'));
    expect(reply.success).toBe(false);
    expect(reply.error).toContain('[redacted]');
    assertNoPlaintext('dns reply', reply);
  });

  it('redacts a transport construction error', async () => {
    wsMock.FakeWebSocket.throwOnConstruct = new Error(`Invalid header value v=${SECRET}`);
    const reply = await handler()(makeEvent(), secretConnect('ctor'));
    expect(reply.success).toBe(false);
    assertNoPlaintext('construct reply', reply);
    assertNoPlaintext('log', mockLogWarn.mock.calls);
  });

  it('redacts ws:error and ws:close events and the log line', async () => {
    await handler()(makeEvent(), secretConnect('events'));
    const ws = wsMock.FakeWebSocket.instances[0]!;
    ws.fire('error', new Error(`Unexpected server response for api_key=${SECRET}`));
    ws.fire('close', 1008, Buffer.from(`bad token ${SECRET} for ${HOST_PART}`));

    const events = mockEmitTo.mock.calls.filter(
      ([, channel]) => channel === 'ws:error:events' || channel === 'ws:close:events'
    );
    expect(events).toHaveLength(2);
    assertNoPlaintext('events', events);
    assertNoPlaintext('log', mockLogWarn.mock.calls);
  });

  it('a missing secret fails closed without echoing any resolved value', async () => {
    const reply = await handler()(makeEvent(), {
      ...secretConnect('missing'),
      secretVariables: {
        tenant: { kind: 'handle', id: 'h-host' },
        tok: { kind: 'handle', id: 'gone' },
      },
    });
    expect(reply).toEqual({
      success: false,
      error:
        'WebSocket auth setup failed: Secret variable "tok" is unavailable on this desktop device',
    });
    expect(wsMock.FakeWebSocket.instances).toHaveLength(0);
  });
});

const sseHandler = () =>
  mockHandle.mock.calls.find((c) => c[0] === IPC.sse.connect)?.[1] as (
    e: unknown,
    p: unknown
  ) => Promise<Reply>;

const sseSecretConnect = (connectionId: string) => ({
  ...secretConnect(connectionId),
  url: 'https://api.example.com/graphql/stream?tenant={{tenant}}',
  jsonBody: '{"query":"subscription { tick }"}',
});

function sseBody(text = ''): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      if (text) c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

describe('sse:connect (graphql-sse) never echoes main-resolved secrets', () => {
  beforeEach(() => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    stopSseCleanup();
    mockHandle.mockClear();
    mockEmitTo.mockClear();
    mockLogWarn.mockClear();
    mockStreaming.mockReset();
    mockResolveSafe.mockReset();
    mockResolveSafe.mockResolvedValue({
      host: 'api.example.com',
      ip: '203.0.113.9',
      port: 443,
      family: 4,
    });
    registerSseHandlerIPC();
  });

  it('applies the secrets on the wire but returns only { success: true }', async () => {
    mockStreaming.mockResolvedValue({
      ok: true,
      response: { status: 200, statusText: 'OK', body: sseBody() },
    });
    const reply = await sseHandler()(makeEvent(), sseSecretConnect('ok'));
    expect(reply).toEqual({ success: true });
    const spec = mockStreaming.mock.calls[0]?.[0] as {
      url: string;
      headers: Record<string, string>;
    };
    expect(spec.url).toContain(encodeURIComponent(HOST_PART));
    expect(spec.headers['X-Echo']).toBe(`v=${SECRET}`);
    assertNoPlaintext('sse open events', mockEmitTo.mock.calls);
  });

  it('redacts an SSRF/DNS failure that quotes the resolved URL', async () => {
    mockResolveSafe.mockImplementationOnce(async (url: string) => {
      throw new Error(`URL rejected by policy: ${url}`);
    });
    const reply = await sseHandler()(makeEvent(), sseSecretConnect('dns'));
    expect(reply.success).toBe(false);
    expect(reply.error).toContain('[redacted]');
    assertNoPlaintext('sse dns reply', reply);
  });

  it('redacts proxy failures, status lines, events and logs', async () => {
    mockStreaming.mockResolvedValueOnce({
      ok: false,
      payload: { error: `Proxy request failed: ${SECRET} @ ${HOST_PART}` },
    });
    const failed = await sseHandler()(makeEvent(), sseSecretConnect('proxy'));
    assertNoPlaintext('sse proxy reply', failed);

    mockStreaming.mockResolvedValueOnce({
      ok: true,
      response: { status: 403, statusText: `denied ${SECRET}`, body: sseBody() },
    });
    const status = await sseHandler()(makeEvent(), sseSecretConnect('status'));
    assertNoPlaintext('sse status reply', status);

    mockStreaming.mockResolvedValueOnce({
      ok: true,
      response: {
        status: 200,
        statusText: 'OK',
        body: sseBody(`id: ${SECRET}\nevent: ${HOST_PART}\ndata: ${SECRET}\n\n`),
      },
    });
    await sseHandler()(makeEvent(), sseSecretConnect('events'));
    await vi.waitFor(() =>
      expect(mockEmitTo.mock.calls.some(([, ch]) => ch === 'sse:event:events')).toBe(true)
    );
    assertNoPlaintext('sse events', mockEmitTo.mock.calls);
    assertNoPlaintext('sse log', mockLogWarn.mock.calls);
  });

  it('a missing secret fails closed without echoing any resolved value', async () => {
    const reply = await sseHandler()(makeEvent(), {
      ...sseSecretConnect('missing'),
      secretVariables: {
        tenant: { kind: 'handle', id: 'h-host' },
        tok: { kind: 'handle', id: 'gone' },
      },
    });
    expect(reply).toEqual({
      success: false,
      error: 'SSE auth setup failed: Secret variable "tok" is unavailable on this desktop device',
    });
    expect(mockStreaming).not.toHaveBeenCalled();
  });
});
