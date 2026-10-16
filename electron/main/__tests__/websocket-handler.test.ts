// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const mockResolveSafe = vi.hoisted(() =>
  vi.fn(async () => ({
    host: 'echo.example.com',
    ip: '203.0.113.1',
    port: 443,
    family: 4 as const,
  }))
);

// Fake `ws` socket: records constructor calls and lifecycle listeners so tests
// can fire open/message/close without a real network connection.
const wsMock = vi.hoisted(() => {
  class FakeWebSocket {
    static OPEN = 1;
    static instances: FakeWebSocket[] = [];
    readyState = 1; // OPEN
    protocol = '';
    url: string;
    options: { headers?: Record<string, string>; followRedirects?: boolean } | undefined;
    send = vi.fn();
    close = vi.fn();
    terminate = vi.fn();
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor(
      url: string,
      _protocols?: unknown,
      options?: { headers?: Record<string, string>; followRedirects?: boolean }
    ) {
      this.url = url;
      this.options = options;
      FakeWebSocket.instances.push(this);
    }
    on(evt: string, cb: (...args: unknown[]) => void): this {
      const arr = this.listeners.get(evt) ?? [];
      arr.push(cb);
      this.listeners.set(evt, arr);
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
// StreamRegistry emits through ipc-utils; mock it so emissions are observable
// and the real `electron` import inside ipc-utils never loads.
vi.mock('../ipc/ipc-utils', () => ({ emitTo: mockEmitTo }));
// Keychain stand-in for SecretRef handles (#882): only "main" can map a
// handle id to plaintext.
const KEYCHAIN: Record<string, string> = {
  'h-token': 'keychain-token',
};
vi.mock('../security/secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    const ref = v as { kind?: string; value?: string; id?: string } | undefined;
    if (ref?.kind === 'inline') return ref.value;
    if (ref?.kind === 'handle') return ref.id ? KEYCHAIN[ref.id] : undefined;
    return undefined;
  },
}));
// External-vault resolver: per-test overridable so a connect can be held
// mid-materialization (race tests).
const mockVaultResolve = vi.hoisted(() =>
  vi.fn(
    async (ref: { secretId: string }, _opts?: { signal?: AbortSignal }) => `vault:${ref.secretId}`
  )
);
vi.mock('../security/external-secret-providers', () => ({
  desktopExternalSecretResolver: { resolve: mockVaultResolve },
}));
vi.mock('../security/safe-connect', () => ({
  resolveSafeAddress: mockResolveSafe,
  createPinnedLookup: () => vi.fn(),
}));

import { decodeWsBinaryFrame, encodeWsBinaryFrame } from '@shared/protocol/ws-binary-codec';
import { IPC } from '../../shared/channels';
import {
  registerWebSocketHandlerIPC,
  stopWebSocketCleanup,
  wsRateLimiter,
} from '../handlers/websocket-handler';
import { setExecutionPolicy } from '../security/execution-policy';

type IpcHandler = (e: unknown, p: unknown) => Promise<{ success: boolean; error?: string }>;

function handlerFor(channel: string): IpcHandler {
  const call = mockHandle.mock.calls.find((c) => c[0] === channel);
  return call?.[1] as IpcHandler;
}

const TRUSTED_URL = 'file:///app/dist/web/index.html';
let nextSenderId = 1000;

/**
 * Fake IpcMainInvokeEvent. Fresh sender id per event so the real (module-level)
 * wsRateLimiter and bindRendererCleanup's per-id dedupe can't leak across tests.
 */
function makeEvent(frameUrl = TRUSTED_URL) {
  const id = nextSenderId++;
  const destroyedListeners: Array<() => void> = [];
  return {
    senderId: id,
    event: {
      sender: {
        id,
        isDestroyed: () => false,
        once: (evt: string, cb: () => void) => {
          if (evt === 'destroyed') destroyedListeners.push(cb);
        },
      },
      senderFrame: { url: frameUrl, parent: null },
    },
    destroy: () => destroyedListeners.splice(0).forEach((cb) => cb()),
  };
}

const validConnect = (connectionId: string) => ({
  connectionId,
  url: 'wss://echo.example.com/socket',
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('websocket-handler', () => {
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
    mockResolveSafe.mockClear();
    wsMock.FakeWebSocket.instances.length = 0;
    registerWebSocketHandlerIPC();
  });
  afterEach(() => stopWebSocketCleanup());

  it('registers exactly the IPC.ws channels', () => {
    const channels = mockHandle.mock.calls.map((c) => c[0]).sort();
    expect(channels).toEqual(Object.values(IPC.ws).sort());
  });

  it('rejects ws:connect from an untrusted frame before doing any work', async () => {
    const { event } = makeEvent('https://attacker.example/');
    await expect(handlerFor(IPC.ws.connect)(event, validConnect('c1'))).rejects.toThrow(
      /untrusted frame/
    );
    expect(wsMock.FakeWebSocket.instances).toHaveLength(0);
  });

  it('rejects an invalid payload via the Zod schema (non-ws scheme)', async () => {
    const { event } = makeEvent();
    await expect(
      handlerFor(IPC.ws.connect)(event, { connectionId: 'c1', url: 'http://example.com/' })
    ).rejects.toThrow(/Invalid IPC payload for ws:connect/);
  });

  it('rejects a connect once the sender has drained its rate-limit bucket', async () => {
    const { event, senderId } = makeEvent();
    try {
      let guard = 0;
      while (wsRateLimiter.check(senderId) && guard++ < 1000) {
        /* drain the sender's bucket */
      }
      const res = await handlerFor(IPC.ws.connect)(event, validConnect('c-rl'));
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Rate limit/);
      expect(wsMock.FakeWebSocket.instances).toHaveLength(0);
    } finally {
      wsRateLimiter.dispose(senderId);
    }
  });

  it('emits targeted open/message/close events over the connection lifecycle', async () => {
    const { event, senderId } = makeEvent();
    const res = await handlerFor(IPC.ws.connect)(event, validConnect('c1'));
    expect(res.success).toBe(true);
    expect(mockResolveSafe).toHaveBeenCalledWith('wss://echo.example.com/socket', {
      allowLocalhost: true,
      allowPrivateIPs: false,
      allowedSchemes: ['ws:', 'wss:'],
    });

    const ws = wsMock.FakeWebSocket.instances[0]!;
    ws.fire('open');
    expect(mockEmitTo).toHaveBeenCalledWith(senderId, 'ws:open:c1', {
      protocol: '',
      extensions: '',
    });

    ws.fire('message', Buffer.from('hi'), false);
    expect(mockEmitTo).toHaveBeenCalledWith(senderId, 'ws:message:c1', {
      type: 'text',
      data: 'hi',
    });

    ws.fire('message', Buffer.from('bin'), true);
    expect(mockEmitTo).toHaveBeenCalledWith(senderId, 'ws:message:c1', {
      type: 'binary',
      data: Buffer.from('bin').toString('base64'),
    });

    // Unexpected close (not explicitly requested) is forwarded.
    ws.fire('close', 1006, Buffer.from('gone'));
    expect(mockEmitTo).toHaveBeenCalledWith(senderId, 'ws:close:c1', {
      code: 1006,
      reason: 'gone',
    });
  });

  it('ws:send forwards to the open socket and reports Not connected for unknown ids', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.ws.connect)(event, validConnect('c1'));
    const ws = wsMock.FakeWebSocket.instances[0]!;

    const ok = await handlerFor(IPC.ws.send)(event, { connectionId: 'c1', message: 'ping' });
    expect(ok).toEqual({ success: true });
    expect(ws.send).toHaveBeenCalledWith('ping');

    const missing = await handlerFor(IPC.ws.send)(event, {
      connectionId: 'nope',
      message: 'ping',
    });
    expect(missing).toEqual({ success: false, error: 'Not connected' });
  });

  it('round-trips arbitrary binary bytes renderer→main→renderer via the shared base64 codec (#897)', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.ws.connect)(event, validConnect('bin-rt'));
    const ws = wsMock.FakeWebSocket.instances[0]!;
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);

    // Renderer → main: the payload the renderer puts on IPC.
    const sent = await handlerFor(IPC.ws.send)(event, {
      connectionId: 'bin-rt',
      message: encodeWsBinaryFrame(bytes),
      binary: true,
    });
    expect(sent).toEqual({ success: true });
    const onWire = ws.send.mock.calls[0]![0] as Uint8Array;
    expect(Array.from(onWire)).toEqual(Array.from(bytes));

    // Server echoes the frame → main → renderer decodes the same bytes.
    mockEmitTo.mockClear();
    ws.fire('message', Buffer.from(onWire), true);
    const emitted = mockEmitTo.mock.calls[0]![2] as { type: string; data: string };
    expect(emitted.type).toBe('binary');
    expect(Array.from(decodeWsBinaryFrame(emitted.data))).toEqual(Array.from(bytes));

    // A non-base64 payload (the old hex format) is refused, not sent as garbage.
    ws.send.mockClear();
    const bad = await handlerFor(IPC.ws.send)(event, {
      connectionId: 'bin-rt',
      message: '48 69',
      binary: true,
    });
    expect(bad.success).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('explicit disconnect closes gracefully (1000) and suppresses the trailing close event', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.ws.connect)(event, validConnect('c1'));
    const ws = wsMock.FakeWebSocket.instances[0]!;

    const res = await handlerFor(IPC.ws.disconnect)(event, { connectionId: 'c1' });
    expect(res).toEqual({ success: true });
    expect(ws.close).toHaveBeenCalledWith(1000, 'Client disconnected');

    mockEmitTo.mockClear();
    ws.fire('close', 1000, Buffer.from(''));
    expect(mockEmitTo.mock.calls.some((c) => c[1] === 'ws:close:c1')).toBe(false);
  });

  it('reconnecting with the same id hard-terminates the previous socket', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.ws.connect)(event, validConnect('c1'));
    await handlerFor(IPC.ws.connect)(event, validConnect('c1'));
    const [first, second] = wsMock.FakeWebSocket.instances;
    expect(first!.terminate).toHaveBeenCalled();
    expect(second!.terminate).not.toHaveBeenCalled();
  });

  it('lets two renderers independently use the same id and cleans up only the destroyed owner', async () => {
    const first = makeEvent();
    const second = makeEvent();
    await expect(handlerFor(IPC.ws.connect)(first.event, validConnect('shared'))).resolves.toEqual({
      success: true,
    });
    const firstSocket = wsMock.FakeWebSocket.instances[0]!;
    await expect(
      handlerFor(IPC.ws.send)(second.event, {
        connectionId: 'shared',
        message: 'not-owned',
      })
    ).resolves.toEqual({ success: false, error: 'Not connected' });
    await expect(
      handlerFor(IPC.ws.disconnect)(second.event, { connectionId: 'shared' })
    ).resolves.toEqual({ success: true });
    expect(firstSocket.send).not.toHaveBeenCalled();
    expect(firstSocket.close).not.toHaveBeenCalled();

    await expect(handlerFor(IPC.ws.connect)(second.event, validConnect('shared'))).resolves.toEqual(
      { success: true }
    );
    const secondSocket = wsMock.FakeWebSocket.instances[1]!;

    await expect(
      handlerFor(IPC.ws.send)(first.event, {
        connectionId: 'shared',
        message: 'first',
      })
    ).resolves.toEqual({ success: true });
    await expect(
      handlerFor(IPC.ws.send)(second.event, {
        connectionId: 'shared',
        message: 'second',
      })
    ).resolves.toEqual({ success: true });
    expect(firstSocket.send).toHaveBeenCalledWith('first');
    expect(secondSocket.send).toHaveBeenCalledWith('second');

    first.destroy();
    expect(firstSocket.terminate).toHaveBeenCalled();
    expect(secondSocket.terminate).not.toHaveBeenCalled();
    await expect(
      handlerFor(IPC.ws.send)(second.event, {
        connectionId: 'shared',
        message: 'still-live',
      })
    ).resolves.toEqual({ success: true });
    expect(secondSocket.send).toHaveBeenCalledWith('still-live');
  });

  it('reserves concurrent same-id connects independently per renderer before DNS', async () => {
    const first = makeEvent();
    const second = makeEvent();
    const firstDns = deferred<{
      host: string;
      ip: string;
      port: number;
      family: 4;
    }>();
    const pinned = {
      host: 'echo.example.com',
      ip: '203.0.113.1',
      port: 443,
      family: 4 as const,
    };
    mockResolveSafe.mockImplementationOnce(() => firstDns.promise);

    const firstConnect = handlerFor(IPC.ws.connect)(first.event, validConnect('raced'));
    const secondConnect = handlerFor(IPC.ws.connect)(second.event, validConnect('raced'));

    expect(mockResolveSafe).toHaveBeenCalledTimes(2);
    await expect(secondConnect).resolves.toEqual({ success: true });
    expect(wsMock.FakeWebSocket.instances).toHaveLength(1);

    firstDns.resolve(pinned);
    await expect(firstConnect).resolves.toEqual({ success: true });
    expect(wsMock.FakeWebSocket.instances).toHaveLength(2);
    const firstSocket = wsMock.FakeWebSocket.instances[1]!;
    expect(firstSocket.terminate).not.toHaveBeenCalled();

    firstSocket.fire('message', Buffer.from('current'), false);
    expect(mockEmitTo).toHaveBeenCalledWith(first.senderId, 'ws:message:raced', {
      type: 'text',
      data: 'current',
    });
  });

  it('keeps the first pending owner reconnect and suppresses stale socket events', async () => {
    const owner = makeEvent();
    await handlerFor(IPC.ws.connect)(owner.event, validConnect('shared'));
    const previous = wsMock.FakeWebSocket.instances[0]!;
    const reconnectDns = deferred<{
      host: string;
      ip: string;
      port: number;
      family: 4;
    }>();
    mockResolveSafe.mockClear();
    mockResolveSafe.mockImplementationOnce(() => reconnectDns.promise);

    const firstReconnect = handlerFor(IPC.ws.connect)(owner.event, validConnect('shared'));
    const secondReconnect = handlerFor(IPC.ws.connect)(owner.event, validConnect('shared'));

    expect(mockResolveSafe).toHaveBeenCalledTimes(1);
    await expect(secondReconnect).resolves.toEqual({ success: false, error: 'Not connected' });
    expect(wsMock.FakeWebSocket.instances).toHaveLength(1);

    reconnectDns.resolve({
      host: 'echo.example.com',
      ip: '203.0.113.1',
      port: 443,
      family: 4,
    });
    await expect(firstReconnect).resolves.toEqual({ success: true });
    const current = wsMock.FakeWebSocket.instances[1]!;
    expect(previous.terminate).toHaveBeenCalled();
    expect(current.terminate).not.toHaveBeenCalled();

    mockEmitTo.mockClear();
    previous.fire('open');
    previous.fire('message', Buffer.from('stale'), false);
    previous.fire('error', new Error('stale'));
    expect(mockEmitTo).not.toHaveBeenCalled();

    current.fire('message', Buffer.from('current'), false);
    expect(mockEmitTo).toHaveBeenCalledWith(owner.senderId, 'ws:message:shared', {
      type: 'text',
      data: 'current',
    });
  });

  it('releases a failed pending claim so another renderer can connect', async () => {
    const first = makeEvent();
    const second = makeEvent();
    mockResolveSafe.mockRejectedValueOnce(new Error('dns failed'));

    await expect(
      handlerFor(IPC.ws.connect)(first.event, validConnect('retryable'))
    ).resolves.toEqual({
      success: false,
      error: 'dns failed',
    });
    await expect(
      handlerFor(IPC.ws.connect)(second.event, validConnect('retryable'))
    ).resolves.toEqual({ success: true });
    expect(wsMock.FakeWebSocket.instances).toHaveLength(1);
  });

  it('releases a destroyed renderer pending claim and rejects its late setup', async () => {
    const first = makeEvent();
    const second = makeEvent();
    const firstDns = deferred<{
      host: string;
      ip: string;
      port: number;
      family: 4;
    }>();
    mockResolveSafe.mockImplementationOnce(() => firstDns.promise);

    const firstConnect = handlerFor(IPC.ws.connect)(first.event, validConnect('released'));
    first.destroy();
    await expect(
      handlerFor(IPC.ws.connect)(second.event, validConnect('released'))
    ).resolves.toEqual({ success: true });
    const winner = wsMock.FakeWebSocket.instances[0]!;

    firstDns.resolve({
      host: 'echo.example.com',
      ip: '203.0.113.1',
      port: 443,
      family: 4,
    });
    await expect(firstConnect).resolves.toEqual({ success: false, error: 'Not connected' });
    expect(wsMock.FakeWebSocket.instances).toHaveLength(1);
    expect(winner.terminate).not.toHaveBeenCalled();
  });

  it('a disconnect while a plain connect is still resolving DNS cancels it (#908)', async () => {
    const { event } = makeEvent();
    const dns = deferred<{ host: string; ip: string; port: number; family: 4 }>();
    mockResolveSafe.mockImplementationOnce(() => dns.promise);

    const pending = handlerFor(IPC.ws.connect)(event, validConnect('early'));
    await expect(handlerFor(IPC.ws.disconnect)(event, { connectionId: 'early' })).resolves.toEqual({
      success: true,
    });
    dns.resolve({ host: 'echo.example.com', ip: '203.0.113.1', port: 443, family: 4 });

    await expect(pending).resolves.toEqual({ success: false, error: 'Not connected' });
    expect(wsMock.FakeWebSocket.instances).toHaveLength(0);
  });

  it('a cancelled pending connect does not release the fresh claim of a same-id reconnect', async () => {
    const { event } = makeEvent();
    const pinned = { host: 'echo.example.com', ip: '203.0.113.1', port: 443, family: 4 as const };
    const staleDns = deferred<typeof pinned>();
    const freshDns = deferred<typeof pinned>();
    mockResolveSafe
      .mockImplementationOnce(() => staleDns.promise)
      .mockImplementationOnce(() => freshDns.promise);

    const stale = handlerFor(IPC.ws.connect)(event, validConnect('again'));
    await handlerFor(IPC.ws.disconnect)(event, { connectionId: 'again' });
    const fresh = handlerFor(IPC.ws.connect)(event, validConnect('again'));
    expect(mockResolveSafe).toHaveBeenCalledTimes(2); // fresh claim reserved

    staleDns.resolve(pinned);
    await expect(stale).resolves.toEqual({ success: false, error: 'Not connected' });
    // The stale connect's finally must not have dropped the fresh claim.
    await expect(handlerFor(IPC.ws.connect)(event, validConnect('again'))).resolves.toEqual({
      success: false,
      error: 'Not connected',
    });

    freshDns.resolve(pinned);
    await expect(fresh).resolves.toEqual({ success: true });
    expect(wsMock.FakeWebSocket.instances).toHaveLength(1);
  });

  it('tears down the connection when its renderer is destroyed', async () => {
    const { event, destroy } = makeEvent();
    await handlerFor(IPC.ws.connect)(event, validConnect('c1'));
    const ws = wsMock.FakeWebSocket.instances[0]!;

    destroy();
    expect(ws.terminate).toHaveBeenCalled();
    // The entry is gone: a subsequent send reports Not connected.
    const res = await handlerFor(IPC.ws.send)(event, { connectionId: 'c1', message: 'x' });
    expect(res).toEqual({ success: false, error: 'Not connected' });
  });

  it('stopWebSocketCleanup terminates every live connection (register/teardown symmetry)', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.ws.connect)(event, validConnect('c1'));
    await handlerFor(IPC.ws.connect)(event, validConnect('c2'));

    stopWebSocketCleanup();
    for (const ws of wsMock.FakeWebSocket.instances) {
      expect(ws.terminate).toHaveBeenCalled();
    }
  });

  describe('main-side handshake auth (GraphQL subscriptions, #878/#882)', () => {
    it('resolves a handle-backed Bearer into the upgrade headers; IPC reply carries no plaintext', async () => {
      const { event } = makeEvent();
      const res = await handlerFor(IPC.ws.connect)(event, {
        ...validConnect('gql-1'),
        headers: { 'X-Tenant': 'acme' },
        auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'h-token' } } },
      });
      expect(res).toEqual({ success: true });
      expect(JSON.stringify(res)).not.toContain('keychain-token');
      const ws = wsMock.FakeWebSocket.instances[0]!;
      expect(ws.options?.headers).toEqual({
        'X-Tenant': 'acme',
        Authorization: 'Bearer keychain-token',
      });
    });

    it('appends a handle-backed query API key before the SSRF check', async () => {
      const { event } = makeEvent();
      await handlerFor(IPC.ws.connect)(event, {
        ...validConnect('gql-2'),
        auth: {
          type: 'api-key',
          apiKey: { key: 'api_key', value: { kind: 'handle', id: 'h-token' }, in: 'query' },
        },
      });
      const finalUrl = 'wss://echo.example.com/socket?api_key=keychain-token';
      expect(mockResolveSafe).toHaveBeenCalledWith(finalUrl, expect.anything());
      expect(wsMock.FakeWebSocket.instances[0]?.url).toBe(finalUrl);
    });

    it('materializes SecretRef-backed {{vars}} in handshake headers', async () => {
      const { event } = makeEvent();
      await handlerFor(IPC.ws.connect)(event, {
        connectionId: 'gql-3',
        url: 'wss://placeholder.invalid/graphql',
        headers: { 'X-Secret': '{{tok}}' },
        secretVariables: { tok: { kind: 'handle', id: 'h-token' } },
      });
      expect(wsMock.FakeWebSocket.instances[0]?.options?.headers).toEqual({
        'X-Secret': 'keychain-token',
      });
    });

    it('fails without a socket when a handle is unavailable, without echoing secrets', async () => {
      const { event } = makeEvent();
      const res = await handlerFor(IPC.ws.connect)(event, {
        ...validConnect('gql-4'),
        secretVariables: { gone: { kind: 'handle', id: 'missing' } },
      });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/WebSocket auth setup failed: Secret variable "gone"/);
      expect(mockResolveSafe).not.toHaveBeenCalled();
      expect(wsMock.FakeWebSocket.instances).toHaveLength(0);
    });

    const vaultRef = {
      kind: 'external',
      provider: 'aws-secrets-manager',
      profileId: 'p',
      secretId: 'tok',
    } as const;
    const vaultConnect = (connectionId: string) => ({
      ...validConnect(connectionId),
      headers: { 'X-Secret': '{{v}}' },
      secretVariables: { v: vaultRef },
    });
    /** Hold the next vault lookup open; expose its abort signal. */
    function holdVault() {
      const gate = deferred<string>();
      let signal: AbortSignal | undefined;
      mockVaultResolve.mockImplementationOnce(async (_ref, opts) => {
        signal = opts?.signal;
        return gate.promise;
      });
      return { gate, signal: () => signal };
    }

    it('never follows handshake redirects with main-side credentials (plain connects still do)', async () => {
      const { event } = makeEvent();
      await handlerFor(IPC.ws.connect)(event, validConnect('plain'));
      await handlerFor(IPC.ws.connect)(event, {
        ...validConnect('authed'),
        auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'h-token' } } },
      });
      const [plain, authed] = wsMock.FakeWebSocket.instances;
      expect(plain?.options?.followRedirects).toBe(true);
      expect(authed?.options?.followRedirects).toBe(false);
    });

    it('fails closed when a handle-backed credential is revoked', async () => {
      const { event } = makeEvent();
      const res = await handlerFor(IPC.ws.connect)(event, {
        ...validConnect('revoked'),
        auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'revoked' } } },
      });
      expect(res).toEqual({
        success: false,
        error: 'WebSocket auth setup failed: Auth credential is unavailable on this device',
      });
      expect(wsMock.FakeWebSocket.instances).toHaveLength(0);
    });

    it('does not burn a rate-limit token on a policy rejection', async () => {
      setExecutionPolicy({
        security: { allowLocalhost: true, allowPrivateIPs: false },
        proxy: { enabled: true, type: 'http', host: 'p.example', port: 3128, bypassList: [] },
        timeout: 30_000,
        tls: { verifySsl: true, serverCipherOrder: false },
        certificates: { clientCertificates: [], caCertificates: [] },
      });
      const { event, senderId } = makeEvent();
      const spy = vi.spyOn(wsRateLimiter, 'check');
      try {
        const res = await handlerFor(IPC.ws.connect)(event, vaultConnect('policy-first'));
        expect(res.success).toBe(false);
        expect(spy).not.toHaveBeenCalled();
        expect(mockVaultResolve).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
        wsRateLimiter.dispose(senderId);
      }
    });

    it('cancels a connect still resolving credentials when the renderer disconnects', async () => {
      const { event } = makeEvent();
      const held = holdVault();
      const pending = handlerFor(IPC.ws.connect)(event, vaultConnect('cancel-me'));
      await vi.waitFor(() => expect(held.signal()).toBeDefined());

      await handlerFor(IPC.ws.disconnect)(event, { connectionId: 'cancel-me' });
      expect(held.signal()?.aborted).toBe(true);
      held.gate.resolve('late-secret');

      await expect(pending).resolves.toEqual({ success: false, error: 'Not connected' });
      expect(mockResolveSafe).not.toHaveBeenCalled();
      expect(wsMock.FakeWebSocket.instances).toHaveLength(0);
    });

    it('rejects a same-id connect while the first is still resolving credentials', async () => {
      const { event } = makeEvent();
      const held = holdVault();
      const first = handlerFor(IPC.ws.connect)(event, vaultConnect('dup'));
      await vi.waitFor(() => expect(held.signal()).toBeDefined());
      await expect(handlerFor(IPC.ws.connect)(event, validConnect('dup'))).resolves.toEqual({
        success: false,
        error: 'Not connected',
      });
      held.gate.resolve('secret');
      await expect(first).resolves.toEqual({ success: true });
      expect(wsMock.FakeWebSocket.instances).toHaveLength(1);
    });

    it('drops the connect when its renderer is destroyed mid-resolution', async () => {
      const { event, destroy } = makeEvent();
      const held = holdVault();
      const pending = handlerFor(IPC.ws.connect)(event, vaultConnect('destroyed'));
      await vi.waitFor(() => expect(held.signal()).toBeDefined());

      destroy();
      expect(held.signal()?.aborted).toBe(true);
      held.gate.resolve('late-secret');

      await expect(pending).resolves.toEqual({ success: false, error: 'Not connected' });
      expect(wsMock.FakeWebSocket.instances).toHaveLength(0);
    });

    it('counts connects that are resolving credentials against the connection cap', async () => {
      const gates: Array<ReturnType<typeof deferred<string>>> = [];
      mockVaultResolve.mockImplementation(async () => {
        const gate = deferred<string>();
        gates.push(gate);
        return gate.promise;
      });
      try {
        const inFlight = Array.from({ length: 50 }, (_, i) =>
          handlerFor(IPC.ws.connect)(makeEvent().event, vaultConnect(`cap-${i}`))
        );
        await vi.waitFor(() => expect(gates).toHaveLength(50));
        await expect(
          handlerFor(IPC.ws.connect)(makeEvent().event, validConnect('cap-over'))
        ).resolves.toEqual({ success: false, error: 'Too many open connections.' });
        for (const gate of gates) gate.resolve('s');
        await Promise.all(inFlight);
      } finally {
        mockVaultResolve.mockReset();
        mockVaultResolve.mockImplementation(async (ref) => `vault:${ref.secretId}`);
      }
    });

    it('redacts a server-reflected secret in text and binary frames for main-side-auth sockets only', async () => {
      const { event, senderId } = makeEvent();
      await handlerFor(IPC.ws.connect)(event, {
        ...validConnect('authed-msg'),
        auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'h-token' } } },
      });
      await handlerFor(IPC.ws.connect)(event, validConnect('plain-msg'));
      const [authed, plain] = wsMock.FakeWebSocket.instances;
      mockEmitTo.mockClear();

      authed!.fire('message', Buffer.from('{"echo":"keychain-token"}'), false);
      authed!.fire('message', Buffer.from('bin keychain-token'), true);
      authed!.fire('message', Buffer.from([0xff, 0x00, 0x01]), true);
      plain!.fire('message', Buffer.from('{"echo":"keychain-token"}'), false);

      expect(mockEmitTo).toHaveBeenCalledWith(senderId, 'ws:message:authed-msg', {
        type: 'text',
        data: '{"echo":"[redacted]"}',
      });
      expect(mockEmitTo).toHaveBeenCalledWith(senderId, 'ws:message:authed-msg', {
        type: 'binary',
        data: Buffer.from('bin [redacted]').toString('base64'),
      });
      // Binary frames without a secret pass through byte-for-byte.
      expect(mockEmitTo).toHaveBeenCalledWith(senderId, 'ws:message:authed-msg', {
        type: 'binary',
        data: Buffer.from([0xff, 0x00, 0x01]).toString('base64'),
      });
      // Plain connections carry no main-resolved secret: untouched.
      expect(mockEmitTo).toHaveBeenCalledWith(senderId, 'ws:message:plain-msg', {
        type: 'text',
        data: '{"echo":"keychain-token"}',
      });
    });

    it('rejects malformed auth / oversized secretVariables at the Zod boundary', async () => {
      const { event } = makeEvent();
      await expect(
        handlerFor(IPC.ws.connect)(event, { ...validConnect('gql-5'), auth: { type: 'kerberos' } })
      ).rejects.toThrow(/Invalid IPC payload for ws:connect/);
      const tooMany = Object.fromEntries(
        Array.from({ length: 101 }, (_, i) => [`v${i}`, { kind: 'handle', id: `h${i}` }])
      );
      await expect(
        handlerFor(IPC.ws.connect)(event, { ...validConnect('gql-6'), secretVariables: tooMany })
      ).rejects.toThrow(/Invalid IPC payload for ws:connect/);
      expect(wsMock.FakeWebSocket.instances).toHaveLength(0);
    });
  });

  it('fails clearly when execution policy proxy cannot be honored by DNS-pinned lookup', async () => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: {
        enabled: true,
        type: 'http',
        host: 'proxy.example.test',
        port: 3128,
        bypassList: [],
      },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });

    const { event } = makeEvent();
    const res = await handlerFor(IPC.ws.connect)(event, validConnect('policy'));
    expect(res).toEqual({
      success: false,
      error: 'Configured HTTP proxy cannot be honored by this DNS-pinned connection',
    });
    expect(mockResolveSafe).not.toHaveBeenCalled();
    expect(wsMock.FakeWebSocket.instances).toHaveLength(0);
  });
});
