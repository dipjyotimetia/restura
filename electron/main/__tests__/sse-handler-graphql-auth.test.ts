// @vitest-environment node
//
// graphql-sse subscriptions over sse:connect (#878/#882, ADR-0007): SecretRef
// handle auth and SecretRef-backed {{vars}} are resolved in main at wire time,
// fail closed, aren't replayed across redirects, never echo plaintext, and
// in-flight resolution is cancellable. Real Zod validators (not mocked).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'sse-keychain-token';

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const mockResolveSafe = vi.hoisted(() => vi.fn());
const mockStreaming = vi.hoisted(() => vi.fn());
const mockVaultResolve = vi.hoisted(() =>
  vi.fn(
    async (ref: { secretId: string }, _opts?: { signal?: AbortSignal }) => `vault:${ref.secretId}`
  )
);

vi.mock('electron', () => ({ ipcMain: { handle: mockHandle, removeHandler: vi.fn() } }));
vi.mock('../ipc/ipc-utils', () => ({ emitTo: mockEmitTo }));
vi.mock('../security/safe-connect', () => ({
  resolveSafeAddress: mockResolveSafe,
  createPinnedFetch: () => vi.fn(),
}));
vi.mock('@shared/protocol/http-proxy', () => ({ executeHttpProxyStreaming: mockStreaming }));
vi.mock('../security/secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    const ref = v as { kind?: string; value?: string; id?: string } | undefined;
    if (ref?.kind === 'inline') return ref.value;
    if (ref?.kind === 'handle') return ref.id === 'h-token' ? SECRET : undefined;
    return undefined;
  },
}));
vi.mock('../security/external-secret-providers', () => ({
  desktopExternalSecretResolver: { resolve: mockVaultResolve },
}));

import { IPC } from '../../shared/channels';
import { registerSseHandlerIPC, sseRateLimiter, stopSseCleanup } from '../handlers/sse-handler';
import { setExecutionPolicy } from '../security/execution-policy';

type Reply = { success: boolean; error?: string };
const handlerFor = (channel: string) =>
  mockHandle.mock.calls.find((c) => c[0] === channel)?.[1] as (
    e: unknown,
    p: unknown
  ) => Promise<Reply>;

let nextId = 9000;
function makeEvent() {
  const id = nextId++;
  const listeners: Array<() => void> = [];
  return {
    senderId: id,
    event: {
      sender: {
        id,
        isDestroyed: () => false,
        once: (_e: string, cb: () => void) => listeners.push(cb),
      },
      senderFrame: { url: 'file:///app/dist/web/index.html', parent: null },
    },
    destroy: () => listeners.splice(0).forEach((cb) => cb()),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const okStream = () => ({
  ok: true,
  response: {
    status: 200,
    statusText: 'OK',
    body: new ReadableStream({
      start(c) {
        c.close();
      },
    }),
  },
});

const gqlSse = (connectionId: string, extra: Record<string, unknown> = {}) => ({
  connectionId,
  url: 'https://api.example.com/graphql/stream',
  headers: { 'X-Tenant': 'acme' },
  jsonBody: '{"query":"subscription { tick }"}',
  ...extra,
});
const handleBearer = { type: 'bearer', bearer: { token: { kind: 'handle', id: 'h-token' } } };

describe('sse:connect — graphql-sse main-side auth', () => {
  beforeEach(() => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    mockHandle.mockClear();
    mockEmitTo.mockClear();
    mockResolveSafe.mockReset();
    mockResolveSafe.mockResolvedValue({
      host: 'api.example.com',
      ip: '203.0.113.7',
      port: 443,
      family: 4,
    });
    mockStreaming.mockReset();
    mockStreaming.mockResolvedValue(okStream());
    mockVaultResolve.mockClear();
    registerSseHandlerIPC();
  });
  afterEach(() => stopSseCleanup());

  it('resolves a handle-backed Bearer into the POST headers, no redirects, plaintext-free reply', async () => {
    const res = await handlerFor(IPC.sse.connect)(
      makeEvent().event,
      gqlSse('s1', { auth: handleBearer })
    );
    expect(res).toEqual({ success: true });
    const spec = mockStreaming.mock.calls[0]?.[0] as {
      method: string;
      headers: Record<string, string>;
      redirectPolicy?: { maxRedirects?: number };
    };
    expect(spec.method).toBe('POST');
    expect(spec.headers).toMatchObject({
      'X-Tenant': 'acme',
      Authorization: `Bearer ${SECRET}`,
    });
    expect(spec.redirectPolicy).toEqual({ maxRedirects: 0 });
  });

  it('plain SSE keeps following redirects (no redirect policy override)', async () => {
    await handlerFor(IPC.sse.connect)(makeEvent().event, gqlSse('plain'));
    const spec = mockStreaming.mock.calls[0]?.[0] as { redirectPolicy?: unknown };
    expect(spec.redirectPolicy).toBeUndefined();
  });

  it('passes named headers to the follower and validates them', async () => {
    await handlerFor(IPC.sse.connect)(
      makeEvent().event,
      gqlSse('named', { stripOnOriginChange: ['X-Unusual'] })
    );
    const spec = mockStreaming.mock.calls[0]?.[0] as { redirectPolicy?: unknown };
    expect(spec.redirectPolicy).toEqual({ stripOnOriginChange: ['X-Unusual'] });

    mockStreaming.mockClear();
    await handlerFor(IPC.sse.connect)(
      makeEvent().event,
      gqlSse('bad', { stripOnOriginChange: 'X-Unusual' })
    ).catch(() => undefined);
    expect(mockStreaming).not.toHaveBeenCalled();
  });

  it('still follows no redirects when main resolves credentials', async () => {
    await handlerFor(IPC.sse.connect)(
      makeEvent().event,
      gqlSse('both', { auth: handleBearer, stripOnOriginChange: ['X-Unusual'] })
    );
    const spec = mockStreaming.mock.calls[0]?.[0] as { redirectPolicy?: unknown };
    expect(spec.redirectPolicy).toEqual({ maxRedirects: 0 });
  });

  it('appends a handle-backed query API key before the SSRF check', async () => {
    await handlerFor(IPC.sse.connect)(
      makeEvent().event,
      gqlSse('s2', {
        auth: {
          type: 'api-key',
          apiKey: { key: 'api_key', value: { kind: 'handle', id: 'h-token' }, in: 'query' },
        },
      })
    );
    const finalUrl = `https://api.example.com/graphql/stream?api_key=${SECRET}`;
    expect(mockResolveSafe).toHaveBeenCalledWith(finalUrl, expect.anything());
  });

  it('fails closed on a revoked handle — no request sent', async () => {
    const res = await handlerFor(IPC.sse.connect)(
      makeEvent().event,
      gqlSse('s3', { auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'gone' } } } })
    );
    expect(res).toEqual({
      success: false,
      error: 'SSE auth setup failed: Auth credential is unavailable on this device',
    });
    expect(mockStreaming).not.toHaveBeenCalled();
  });

  it('rejects body-framing / denylisted auth header names', async () => {
    for (const key of ['Content-Type', 'Content-Length', 'Cookie', 'Host']) {
      const res = await handlerFor(IPC.sse.connect)(
        makeEvent().event,
        gqlSse(`hdr-${key}`, {
          auth: {
            type: 'api-key',
            apiKey: { key, value: { kind: 'handle', id: 'h-token' }, in: 'header' },
          },
        })
      );
      expect(res.error).toMatch(/not allowed on an SSE request/);
    }
    expect(mockStreaming).not.toHaveBeenCalled();
  });

  it('redacts secrets from failure replies and emitted events', async () => {
    mockStreaming.mockResolvedValueOnce({
      ok: false,
      payload: { error: `upstream said: bad token ${SECRET}` },
    });
    const res = await handlerFor(IPC.sse.connect)(
      makeEvent().event,
      gqlSse('s4', { auth: handleBearer })
    );
    expect(res.success).toBe(false);
    expect(JSON.stringify(res)).not.toContain(SECRET);
    expect(JSON.stringify(mockEmitTo.mock.calls)).not.toContain(SECRET);

    mockResolveSafe.mockImplementationOnce(async (url: string) => {
      throw new Error(`URL rejected by policy: ${url}`);
    });
    const dns = await handlerFor(IPC.sse.connect)(
      makeEvent().event,
      gqlSse('s5', {
        auth: {
          type: 'api-key',
          apiKey: { key: 'k', value: { kind: 'handle', id: 'h-token' }, in: 'query' },
        },
      })
    );
    expect(dns.error).toContain('[redacted]');
    expect(dns.error).not.toContain(SECRET);
  });

  it('cancels a connect still resolving credentials on sse:disconnect', async () => {
    const gate = deferred<string>();
    let signal: AbortSignal | undefined;
    mockVaultResolve.mockImplementationOnce(async (_ref, opts) => {
      signal = opts?.signal;
      return gate.promise;
    });
    const { event } = makeEvent();
    const pending = handlerFor(IPC.sse.connect)(
      event,
      gqlSse('cancel', {
        headers: { 'X-Secret': '{{v}}' },
        secretVariables: {
          v: { kind: 'external', provider: 'aws-secrets-manager', profileId: 'p', secretId: 's' },
        },
      })
    );
    await vi.waitFor(() => expect(signal).toBeDefined());
    await handlerFor(IPC.sse.disconnect)(event, { connectionId: 'cancel' });
    expect(signal?.aborted).toBe(true);
    gate.resolve('late');
    await expect(pending).resolves.toEqual({ success: false, error: 'Not connected' });
    expect(mockResolveSafe).not.toHaveBeenCalled();
    expect(mockStreaming).not.toHaveBeenCalled();
  });

  it('drops the connect when its renderer is destroyed mid-resolution', async () => {
    const gate = deferred<string>();
    let signal: AbortSignal | undefined;
    mockVaultResolve.mockImplementationOnce(async (_ref, opts) => {
      signal = opts?.signal;
      return gate.promise;
    });
    const { event, destroy } = makeEvent();
    const pending = handlerFor(IPC.sse.connect)(
      event,
      gqlSse('destroyed', {
        secretVariables: {
          v: { kind: 'external', provider: 'aws-secrets-manager', profileId: 'p', secretId: 's' },
        },
      })
    );
    await vi.waitFor(() => expect(signal).toBeDefined());
    destroy();
    expect(signal?.aborted).toBe(true);
    gate.resolve('late');
    await expect(pending).resolves.toEqual({ success: false, error: 'Not connected' });
    expect(mockStreaming).not.toHaveBeenCalled();
  });

  it('does not burn a rate-limit token on a policy rejection', async () => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: { enabled: true, type: 'http', host: 'p.example', port: 3128, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    const spy = vi.spyOn(sseRateLimiter, 'check');
    try {
      const res = await handlerFor(IPC.sse.connect)(
        makeEvent().event,
        gqlSse('policy', { auth: handleBearer })
      );
      expect(res.success).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects malformed auth / oversized secretVariables at the Zod boundary', async () => {
    await expect(
      handlerFor(IPC.sse.connect)(makeEvent().event, gqlSse('z1', { auth: { type: 'kerberos' } }))
    ).rejects.toThrow(/Invalid IPC payload/);
    const tooMany = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`v${i}`, { kind: 'handle', id: `h${i}` }])
    );
    await expect(
      handlerFor(IPC.sse.connect)(makeEvent().event, gqlSse('z2', { secretVariables: tooMany }))
    ).rejects.toThrow(/Invalid IPC payload/);
  });
});

describe('sse:connect — upstream lifetime, body release and event redaction', () => {
  beforeEach(() => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    mockHandle.mockClear();
    mockEmitTo.mockClear();
    mockResolveSafe.mockReset();
    mockResolveSafe.mockResolvedValue({
      host: 'api.example.com',
      ip: '203.0.113.7',
      port: 443,
      family: 4,
    });
    mockStreaming.mockReset();
    registerSseHandlerIPC();
  });
  afterEach(() => stopSseCleanup());

  /** A body that stays open until cancelled; records the cancel. */
  function openBody(chunks: string[] = []) {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
      },
      cancel,
    });
    return { body, cancel };
  }
  const streamingSignal = (call = 0) =>
    (mockStreaming.mock.calls[call]?.[2] as { signal?: AbortSignal } | undefined)?.signal;

  it.each([
    ['plain SSE', {}],
    ['graphql-sse with main-side auth', { auth: handleBearer }],
  ])(
    '%s: sse:disconnect after the stream opened aborts the upstream request',
    async (_n, extra) => {
      const { body } = openBody();
      mockStreaming.mockResolvedValue({
        ok: true,
        response: { status: 200, statusText: 'OK', body },
      });
      const { event } = makeEvent();
      const res = await handlerFor(IPC.sse.connect)(event, gqlSse('live', extra));
      expect(res).toEqual({ success: true });
      const signal = streamingSignal();
      expect(signal?.aborted).toBe(false);

      await handlerFor(IPC.sse.disconnect)(event, { connectionId: 'live' });
      expect(signal?.aborted).toBe(true);
    }
  );

  it('renderer destroy and teardown abort the upstream request too', async () => {
    mockStreaming.mockImplementation(async () => ({
      ok: true,
      response: { status: 200, statusText: 'OK', body: openBody().body },
    }));
    const destroyed = makeEvent();
    await handlerFor(IPC.sse.connect)(destroyed.event, gqlSse('d1'));
    const second = makeEvent();
    await handlerFor(IPC.sse.connect)(second.event, gqlSse('d2'));

    destroyed.destroy();
    expect(streamingSignal(0)?.aborted).toBe(true);
    expect(streamingSignal(1)?.aborted).toBe(false);
    stopSseCleanup();
    expect(streamingSignal(1)?.aborted).toBe(true);
  });

  it('cancels a non-2xx body and redacts the status line', async () => {
    const { body, cancel } = openBody();
    mockStreaming.mockResolvedValue({
      ok: true,
      response: { status: 401, statusText: `bad token ${SECRET}`, body },
    });
    const res = await handlerFor(IPC.sse.connect)(
      makeEvent().event,
      gqlSse('401', { auth: handleBearer })
    );
    expect(res).toEqual({ success: false, error: 'HTTP 401 bad token [redacted]' });
    expect(cancel).toHaveBeenCalled();
    expect(JSON.stringify(mockEmitTo.mock.calls)).not.toContain(SECRET);
  });

  it('a 3xx carrying the secret in Location returns only the status line', async () => {
    const { body, cancel } = openBody();
    mockStreaming.mockResolvedValue({
      ok: true,
      response: {
        status: 302,
        statusText: 'Found',
        headers: { location: `https://evil.example/cb?token=${SECRET}` },
        body,
      },
    });
    const res = await handlerFor(IPC.sse.connect)(
      makeEvent().event,
      gqlSse('302', { auth: handleBearer })
    );
    expect(res).toEqual({ success: false, error: 'HTTP 302 Found' });
    expect(cancel).toHaveBeenCalled();
    expect(JSON.stringify(mockEmitTo.mock.calls)).not.toContain(SECRET);
  });

  it('cancels the body when the claim went stale while the request was in flight', async () => {
    const { body, cancel } = openBody();
    const gate = deferred<unknown>();
    mockStreaming.mockImplementationOnce(() => gate.promise);
    const { event, destroy } = makeEvent();
    const pending = handlerFor(IPC.sse.connect)(event, gqlSse('stale'));
    await vi.waitFor(() => expect(mockStreaming).toHaveBeenCalled());
    destroy();
    gate.resolve({ ok: true, response: { status: 200, statusText: 'OK', body } });
    await expect(pending).resolves.toEqual({ success: false, error: 'Not connected' });
    expect(cancel).toHaveBeenCalled();
  });

  it('redacts a server-reflected secret in event data/event/id for main-side-auth streams only', async () => {
    const frame = `id: ${SECRET}\nevent: next\ndata: {"echo":"${SECRET}"}\n\n`;
    mockStreaming.mockImplementation(async () => ({
      ok: true,
      response: { status: 200, statusText: 'OK', body: openBody([frame]).body },
    }));
    await handlerFor(IPC.sse.connect)(makeEvent().event, gqlSse('authed', { auth: handleBearer }));
    await handlerFor(IPC.sse.connect)(makeEvent().event, gqlSse('plain'));
    await vi.waitFor(() =>
      expect(
        mockEmitTo.mock.calls.filter(([, ch]) => String(ch).startsWith('sse:event:'))
      ).toHaveLength(2)
    );
    const eventFor = (id: string) =>
      mockEmitTo.mock.calls.find(([, ch]) => ch === `sse:event:${id}`)?.[2] as Record<
        string,
        string
      >;
    expect(JSON.stringify(eventFor('authed'))).not.toContain(SECRET);
    expect(eventFor('authed').data).toBe('{"echo":"[redacted]"}');
    // Plain SSE carries no main-resolved secret: payload untouched.
    expect(eventFor('plain').data).toBe(`{"echo":"${SECRET}"}`);
  });

  it('sends jsonBody literally — secret-variable tokens are never substituted into it', async () => {
    mockStreaming.mockResolvedValue({
      ok: true,
      response: { status: 200, statusText: 'OK', body: openBody().body },
    });
    const jsonBody = '{"query":"subscription { tick(t: \\"{{s}}\\") }"}';
    await handlerFor(IPC.sse.connect)(
      makeEvent().event,
      gqlSse('body', {
        jsonBody,
        headers: { 'X-Secret': '{{s}}' },
        secretVariables: { s: { kind: 'handle', id: 'h-token' } },
      })
    );
    const spec = mockStreaming.mock.calls[0]?.[0] as {
      data: string;
      headers: Record<string, string>;
    };
    expect(spec.data).toBe(jsonBody);
    expect(spec.headers['X-Secret']).toBe(SECRET);
  });
});
