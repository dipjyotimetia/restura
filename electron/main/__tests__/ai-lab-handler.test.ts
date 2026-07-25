import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockRemoveHandler = vi.hoisted(() => vi.fn());
const mockResolveSecret = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const mockBindCleanup = vi.hoisted(() => vi.fn());
const mockDispose = vi.hoisted(() =>
  vi.fn(
    (
      entries: Map<string, { webContentsId: number }>,
      deadId: number,
      dispose: (entry: { webContentsId: number }) => void
    ) => {
      for (const [id, entry] of entries) {
        if (entry.webContentsId !== deadId) continue;
        dispose(entry);
        entries.delete(id);
      }
    }
  )
);
const mockRunToCompletion = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, text: 'hi', toolCalls: [] }))
);
const mockListModels = vi.hoisted(() => vi.fn(async () => [{ id: 'llama3.2' }]));
const mockTestConnection = vi.hoisted(() => vi.fn(async () => ({ ok: true, modelCount: 1 })));
const mockExecuteAiChat = vi.hoisted(() => vi.fn());
// Shared across the stream / complete / discovery limiters; default-allow, flipped
// per-test to assert the rate-limit ceilings reject.
const mockRateCheck = vi.hoisted(() => vi.fn(() => true));

// safe-connect fake mimicking the real loopback-only SSRF policy so we can assert
// the handler resolves+pins the right host with the correct `allowLocalhost` flag
// on every outbound path. resolveSafeAddress both validates AND returns a pinned
// address; createPinnedFetch is irrelevant to these assertions.
const mockResolveSafe = vi.hoisted(() =>
  vi.fn(async (url: string, opts: { allowLocalhost: boolean }) => {
    const host = new URL(url).hostname.toLowerCase();
    const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (isLoopback && !opts.allowLocalhost) {
      throw new Error('Localhost URLs are not allowed');
    }
    return { host, ip: '203.0.113.1', port: 443, family: 4 as const };
  })
);

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: mockRemoveHandler },
}));
vi.mock('../security/secret-handle-store', () => ({ resolveSecretHandle: mockResolveSecret }));
vi.mock('../security/safe-connect', () => ({
  resolveSafeAddress: mockResolveSafe,
  createPinnedFetch: () => vi.fn(),
}));
vi.mock('../ipc/ipc-utils', () => ({ emitTo: mockEmitTo }));
vi.mock('../ipc/connection-cleanup', () => ({
  bindRendererCleanup: mockBindCleanup,
  disposeByOwner: mockDispose,
}));
vi.mock('../ipc/ipc-rate-limiter', () => ({
  createKeyedRateLimiter: () => ({ check: mockRateCheck }),
}));
// fetch-fetcher is left REAL so `makePinnedFetcher` forwards to the mocked
// safe-connect below — that's what the resolveSafeAddress assertions verify.
vi.mock('@shared/protocol/ai/ai-complete', () => ({ runToCompletion: mockRunToCompletion }));
vi.mock('@shared/protocol/ai/ai-proxy', () => ({ executeAiChat: mockExecuteAiChat }));
vi.mock('@shared/protocol/ai/model-discovery', () => ({
  listModels: mockListModels,
  testConnection: mockTestConnection,
}));

import { registerAiLabHandlers, unregisterAiLabHandlers } from '../handlers/ai-lab-handler';

const TRUSTED = {
  sender: { id: 1, isDestroyed: () => false },
  senderFrame: { url: 'file:///app/dist/web/index.html' },
};
const OTHER_SENDER = {
  sender: { id: 2, isDestroyed: () => false },
  senderFrame: { url: 'file:///app/dist/web/index.html' },
};
const THIRD_SENDER = {
  sender: { id: 3, isDestroyed: () => false },
  senderFrame: { url: 'file:///app/dist/web/index.html' },
};
const OPERATION_ID = '66666666-6666-4666-8666-666666666666';
const STREAM_ID = '77777777-7777-4777-8777-777777777777';
const STREAM_REQUEST = {
  streamId: STREAM_ID,
  provider: 'ollama',
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
  rawMode: false,
  baseUrlOverride: 'http://localhost:11434',
};

function handlerFor(channel: string) {
  const call = mockHandle.mock.calls.find((c) => c[0] === channel);
  return call?.[1] as (e: unknown, p: unknown) => Promise<{ ok?: boolean; error?: string }>;
}

function deferLabStream() {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let signal: AbortSignal | undefined;
  mockExecuteAiChat.mockImplementationOnce((spec: { signal?: AbortSignal }) => {
    signal = spec.signal;
    return (async function* () {
      await gate;
    })();
  });
  return { finish, getSignal: () => signal };
}

function deferSafeAddress() {
  let finish!: () => void;
  const pending = new Promise<{
    host: string;
    ip: string;
    port: number;
    family: 4;
  }>((resolve) => {
    finish = () =>
      resolve({
        host: 'localhost',
        ip: '127.0.0.1',
        port: 11434,
        family: 4,
      });
  });
  mockResolveSafe.mockImplementationOnce(() => pending);
  return { finish };
}

describe('ai-lab-handler', () => {
  beforeEach(() => {
    mockHandle.mockClear();
    mockResolveSafe.mockClear();
    mockResolveSecret.mockReset();
    mockRunToCompletion.mockClear();
    mockListModels.mockClear();
    mockTestConnection.mockClear();
    mockExecuteAiChat.mockReset();
    mockBindCleanup.mockClear();
    mockDispose.mockClear();
    mockRateCheck.mockReset();
    mockRateCheck.mockReturnValue(true);
    registerAiLabHandlers();
  });
  afterEach(() => unregisterAiLabHandlers());

  it('registers all six AI Lab channels', () => {
    const channels = mockHandle.mock.calls.map((c) => c[0]);
    expect(channels).toEqual(
      expect.arrayContaining([
        'ai-lab:complete',
        'ai-lab:complete:cancel',
        'ai-lab:stream',
        'ai-lab:stream:cancel',
        'ai-lab:list-models',
        'ai-lab:test-connection',
      ])
    );
  });

  it('rejects calls from an untrusted frame', async () => {
    const untrusted = {
      sender: { id: 1, isDestroyed: () => false },
      senderFrame: { url: 'https://attacker.example' },
    };
    await expect(handlerFor('ai-lab:complete')(untrusted, {})).rejects.toThrow(/untrusted frame/);
  });

  describe('complete: SSRF carve-out', () => {
    const base = {
      operationId: OPERATION_ID,
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      rawMode: false,
    };

    it('rejects a cloud provider whose base URL override targets localhost', async () => {
      const res = await handlerFor('ai-lab:complete')(TRUSTED, {
        ...base,
        provider: 'openai',
        baseUrlOverride: 'http://localhost:8080',
        apiKeyHandleId: '11111111-1111-4111-8111-111111111111',
      });
      expect(res.ok).toBe(false);
      expect(mockResolveSafe).toHaveBeenCalledWith('http://localhost:8080', {
        allowLocalhost: false,
      });
      expect(mockRunToCompletion).not.toHaveBeenCalled();
    });

    it('allows a local provider to target localhost and proceeds to the completion', async () => {
      const res = await handlerFor('ai-lab:complete')(TRUSTED, {
        ...base,
        provider: 'ollama',
        baseUrlOverride: 'http://localhost:11434',
      });
      expect(mockResolveSafe).toHaveBeenCalledWith('http://localhost:11434', {
        allowLocalhost: true,
      });
      expect(res.ok).toBe(true);
      expect(mockRunToCompletion).toHaveBeenCalledOnce();
    });
  });

  describe('listModels: SSRF carve-out', () => {
    it('rejects a cloud provider pointed at a localhost base URL', async () => {
      const res = await handlerFor('ai-lab:list-models')(TRUSTED, {
        provider: 'openai',
        baseUrl: 'http://localhost:1234',
        apiKeyHandleId: '11111111-1111-4111-8111-111111111111',
      });
      expect(res.ok).toBe(false);
      expect(mockResolveSafe).toHaveBeenCalledWith('http://localhost:1234', {
        allowLocalhost: false,
      });
      expect(mockListModels).not.toHaveBeenCalled();
    });

    it('allows a local provider to discover models on localhost', async () => {
      const res = await handlerFor('ai-lab:list-models')(TRUSTED, {
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
      });
      expect(res.ok).toBe(true);
      expect(mockResolveSafe).toHaveBeenCalledWith('http://localhost:11434', {
        allowLocalhost: true,
      });
      expect(mockListModels).toHaveBeenCalledOnce();
    });
  });

  it('rejects invalid input', async () => {
    const res = await handlerFor('ai-lab:complete')(TRUSTED, { not: 'valid' });
    expect(res.ok).toBe(false);
  });

  describe('rate-limit ceilings', () => {
    const completeArgs = {
      operationId: OPERATION_ID,
      provider: 'ollama',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      rawMode: false,
      baseUrlOverride: 'http://localhost:11434',
    };

    it('complete rejects (without an upstream call) when the limiter denies', async () => {
      mockRateCheck.mockReturnValue(false);
      const res = await handlerFor('ai-lab:complete')(TRUSTED, completeArgs);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/rate limit/i);
      expect(mockRunToCompletion).not.toHaveBeenCalled();
    });

    it('discovery (list-models) rejects when the limiter denies', async () => {
      mockRateCheck.mockReturnValue(false);
      const res = await handlerFor('ai-lab:list-models')(TRUSTED, {
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
      });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/rate limit/i);
      expect(mockListModels).not.toHaveBeenCalled();
    });
  });

  it('makes another renderer completion cancellation indistinguishable from missing', async () => {
    let resolveComplete!: (value: { ok: true; text: string; toolCalls: never[] }) => void;
    mockRunToCompletion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveComplete = resolve;
        })
    );
    const pending = handlerFor('ai-lab:complete')(TRUSTED, {
      operationId: OPERATION_ID,
      provider: 'ollama',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      rawMode: false,
      baseUrlOverride: 'http://localhost:11434',
    });
    await vi.waitFor(() => expect(mockRunToCompletion).toHaveBeenCalledOnce());

    const missingCancel = await handlerFor('ai-lab:complete:cancel')(OTHER_SENDER, {
      operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    await expect(
      handlerFor('ai-lab:complete:cancel')(OTHER_SENDER, { operationId: OPERATION_ID })
    ).resolves.toEqual(missingCancel);
    expect(missingCancel).toEqual({ ok: true, alreadyDone: true });

    resolveComplete({ ok: true, text: 'done', toolCalls: [] });
    await pending;
  });

  it('returns the same active-ID response to either renderer', async () => {
    let resolveComplete!: (value: { ok: true; text: string; toolCalls: never[] }) => void;
    mockRunToCompletion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveComplete = resolve;
        })
    );
    const args = {
      operationId: OPERATION_ID,
      provider: 'ollama',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      rawMode: false,
      baseUrlOverride: 'http://localhost:11434',
    };
    const pending = handlerFor('ai-lab:complete')(TRUSTED, args);
    await vi.waitFor(() => expect(mockRunToCompletion).toHaveBeenCalledOnce());

    const ownerDuplicate = await handlerFor('ai-lab:complete')(TRUSTED, args);
    await expect(handlerFor('ai-lab:complete')(OTHER_SENDER, args)).resolves.toEqual(
      ownerDuplicate
    );
    expect(ownerDuplicate).toEqual({
      ok: false,
      error: 'A completion with this operation ID is already active.',
    });
    expect(mockRunToCompletion).toHaveBeenCalledOnce();

    resolveComplete({ ok: true, text: 'done', toolCalls: [] });
    await pending;
  });

  it('clears a destroyed DNS-pending completion without late deletion of its successor', async () => {
    const safeAddress = deferSafeAddress();
    let resolveReplacement!: (value: { ok: true; text: string; toolCalls: never[] }) => void;
    mockRunToCompletion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveReplacement = resolve;
        })
    );
    const args = {
      operationId: OPERATION_ID,
      provider: 'ollama',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      rawMode: false,
      baseUrlOverride: 'http://localhost:11434',
    };
    const original = handlerFor('ai-lab:complete')(TRUSTED, args);
    await vi.waitFor(() => expect(mockResolveSafe).toHaveBeenCalledOnce());
    expect(mockBindCleanup).toHaveBeenCalledOnce();

    const teardown = mockBindCleanup.mock.calls[0]?.[2] as (deadId: number) => void;
    teardown(TRUSTED.sender.id);
    const replacement = handlerFor('ai-lab:complete')(OTHER_SENDER, args);
    await vi.waitFor(() => expect(mockRunToCompletion).toHaveBeenCalledOnce());

    safeAddress.finish();
    await expect(original).resolves.toEqual({ ok: false, error: 'Operation cancelled.' });
    await expect(handlerFor('ai-lab:complete')(THIRD_SENDER, args)).resolves.toEqual({
      ok: false,
      error: 'A completion with this operation ID is already active.',
    });

    resolveReplacement({ ok: true, text: 'done', toolCalls: [] });
    await replacement;
  });

  it('rejects a duplicate active completion operation ID', async () => {
    let resolveComplete!: (value: { ok: true; text: string; toolCalls: never[] }) => void;
    mockRunToCompletion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveComplete = resolve;
        })
    );
    const args = {
      operationId: OPERATION_ID,
      provider: 'ollama',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      rawMode: false,
      baseUrlOverride: 'http://localhost:11434',
    };
    const pending = handlerFor('ai-lab:complete')(TRUSTED, args);
    await vi.waitFor(() => expect(mockRunToCompletion).toHaveBeenCalledOnce());

    await expect(handlerFor('ai-lab:complete')(TRUSTED, args)).resolves.toEqual({
      ok: false,
      error: 'A completion with this operation ID is already active.',
    });

    resolveComplete({ ok: true, text: 'done', toolCalls: [] });
    await pending;
  });

  it('settles a cancelled queued completion before an occupied slot is released', async () => {
    const releases: Array<(value: { ok: true; text: string; toolCalls: never[] }) => void> = [];
    mockRunToCompletion.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        })
    );
    const complete = handlerFor('ai-lab:complete');
    const cancel = handlerFor('ai-lab:complete:cancel');
    const operationIds = Array.from(
      { length: 9 },
      (_, index) => `66666666-6666-4666-8666-${String(index).padStart(12, '0')}`
    );
    const calls = operationIds.map((operationId) =>
      complete(TRUSTED, {
        operationId,
        provider: 'ollama',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        rawMode: false,
        baseUrlOverride: 'http://localhost:11434',
      })
    );

    await vi.waitFor(() => expect(mockRunToCompletion).toHaveBeenCalledTimes(8));
    expect(releases).toHaveLength(8);
    await cancel(TRUSTED, { operationId: operationIds[8] });

    const queuedResult = await Promise.race([
      calls[8],
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 25)),
    ]);

    for (const release of releases) release({ ok: true, text: 'done', toolCalls: [] });
    await Promise.all(calls);
    expect(queuedResult).toEqual({ ok: false, error: 'Operation cancelled.' });
  });

  it('treats another renderer stream ID as missing without crossing ownership', async () => {
    const ownerStream = deferLabStream();
    const otherStream = deferLabStream();
    await expect(handlerFor('ai-lab:stream')(TRUSTED, STREAM_REQUEST)).resolves.toMatchObject({
      ok: true,
      streamId: STREAM_ID,
    });
    await vi.waitFor(() => expect(ownerStream.getSignal()).toBeDefined());

    await expect(handlerFor('ai-lab:stream')(OTHER_SENDER, STREAM_REQUEST)).resolves.toEqual({
      ok: true,
      streamId: STREAM_ID,
    });
    await vi.waitFor(() => expect(otherStream.getSignal()).toBeDefined());

    const missingCancel = await handlerFor('ai-lab:stream:cancel')(THIRD_SENDER, {
      streamId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    await expect(
      handlerFor('ai-lab:stream:cancel')(THIRD_SENDER, { streamId: STREAM_ID })
    ).resolves.toEqual(missingCancel);
    expect(missingCancel).toEqual({ ok: true, alreadyDone: true });
    expect(ownerStream.getSignal()?.aborted).toBe(false);
    expect(otherStream.getSignal()?.aborted).toBe(false);

    await expect(
      handlerFor('ai-lab:stream:cancel')(TRUSTED, { streamId: STREAM_ID })
    ).resolves.toEqual({ ok: true });
    expect(ownerStream.getSignal()?.aborted).toBe(true);
    expect(otherStream.getSignal()?.aborted).toBe(false);
    expect(mockEmitTo).toHaveBeenCalledWith(1, `ai-lab:end:${STREAM_ID}`, {
      reason: 'cancelled',
    });
    await expect(
      handlerFor('ai-lab:stream:cancel')(OTHER_SENDER, { streamId: STREAM_ID })
    ).resolves.toEqual({ ok: true });
    expect(otherStream.getSignal()?.aborted).toBe(true);
    ownerStream.finish();
    otherStream.finish();
  });

  it('scopes a DNS-pending stream reservation to its renderer', async () => {
    const safeAddress = deferSafeAddress();
    mockExecuteAiChat.mockImplementation(() => (async function* () {})());
    const ownerPending = handlerFor('ai-lab:stream')(TRUSTED, STREAM_REQUEST);
    await vi.waitFor(() => expect(mockResolveSafe).toHaveBeenCalledOnce());

    await expect(handlerFor('ai-lab:stream')(OTHER_SENDER, STREAM_REQUEST)).resolves.toEqual({
      ok: true,
      streamId: STREAM_ID,
    });
    expect(mockResolveSafe).toHaveBeenCalledTimes(2);

    safeAddress.finish();
    await expect(ownerPending).resolves.toMatchObject({ ok: true, streamId: STREAM_ID });
  });

  it('rejects a destroyed renderer pending stream when address resolution finishes late', async () => {
    const safeAddress = deferSafeAddress();
    mockExecuteAiChat.mockImplementation(() => (async function* () {})());
    const ownerPending = handlerFor('ai-lab:stream')(TRUSTED, STREAM_REQUEST);
    await vi.waitFor(() => expect(mockResolveSafe).toHaveBeenCalledOnce());
    expect(mockBindCleanup).toHaveBeenCalledOnce();

    const teardown = mockBindCleanup.mock.calls[0]?.[2] as (deadId: number) => void;
    teardown(TRUSTED.sender.id);
    safeAddress.finish();

    await expect(ownerPending).resolves.toEqual({
      ok: false,
      error: 'Renderer closed before stream started.',
    });
    expect(mockExecuteAiChat).not.toHaveBeenCalled();
  });

  it('ignores a replaced stream late completion without deleting its successor', async () => {
    const firstStream = deferLabStream();
    const secondStream = deferLabStream();
    await handlerFor('ai-lab:stream')(TRUSTED, STREAM_REQUEST);
    await vi.waitFor(() => expect(firstStream.getSignal()).toBeDefined());

    await expect(handlerFor('ai-lab:stream')(TRUSTED, STREAM_REQUEST)).resolves.toMatchObject({
      ok: true,
      streamId: STREAM_ID,
    });
    await vi.waitFor(() => expect(secondStream.getSignal()).toBeDefined());
    expect(firstStream.getSignal()?.aborted).toBe(true);

    mockEmitTo.mockClear();
    firstStream.finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockEmitTo).not.toHaveBeenCalled();

    await expect(
      handlerFor('ai-lab:stream:cancel')(TRUSTED, { streamId: STREAM_ID })
    ).resolves.toEqual({ ok: true });
    expect(secondStream.getSignal()?.aborted).toBe(true);
    secondStream.finish();
  });
});
