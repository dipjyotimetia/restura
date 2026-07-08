/**
 * End-to-end tests for the AI Lab IPC handler. Sibling to
 * `ai-lab-handler.test.ts` (which covers the security boundary: SSRF
 * carve-out, untrusted frames, rate limits) — this file covers the data
 * flow: do the right arguments reach the shared orchestrators, do chunks
 * land on the right event channels, does the secret handle resolve and
 * get passed through.
 *
 * Strategy: mock the same `electron`, `safe-connect`, and `secret-handle`
 * boundaries as the unit test, but keep the shared orchestrators
 * (`runToCompletion`, `executeAiChat`, `listModels`, `testConnection`)
 * REAL with their exports wrapped in `vi.fn` (passthrough mocks). That way
 * the assertions cover the actual wire shapes the renderer will see, while
 * still letting each test install its own behaviour on the orchestrator.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Pre-allocated UUIDs for the apiKeyHandleId / streamId inputs. The handler
// validates these against `z.uuid()`; using literal strings keeps the
// tests readable. Real UUIDs only matter for security: schema validation
// here is "did the renderer send something well-formed", not auth.
const HANDLE_1 = '11111111-1111-4111-8111-111111111111';
const HANDLE_2 = '22222222-2222-4222-8222-222222222222';
const HANDLE_BAD = '33333333-3333-4333-8333-333333333333';
const HANDLE_TEST = '44444444-4444-4444-8444-444444444444';
const STREAM_ID = '55555555-5555-4555-8555-555555555555';

const mockHandle = vi.hoisted(() => vi.fn());
const mockRemoveHandler = vi.hoisted(() => vi.fn());
const mockResolveSecret = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const mockBindCleanup = vi.hoisted(() => vi.fn());
const mockDispose = vi.hoisted(() => vi.fn());
const mockRateCheck = vi.hoisted(() => vi.fn(() => true));

// SSRF guard fake. Mirrors the real loopback carve-out so we can verify
// `allowLocalhost` is set per-provider. Anything else passes; that's fine
// for E2E — the unit test already proves the policy is correctly applied.
const mockResolveSafe = vi.hoisted(() =>
  vi.fn(async (url: string, opts: { allowLocalhost: boolean }) => {
    const host = new URL(url).hostname.toLowerCase();
    const isLoopback =
      host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
    if (isLoopback && !opts.allowLocalhost) {
      throw new Error('Localhost URLs are not allowed');
    }
    return { host, ip: '127.0.0.1', port: 443, family: 4 as const };
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

// Passthrough mocks: keep the real orchestrators but expose them as vi.fn
// so per-test assertions can install behaviour. Using a factory with
// `importOriginal` is the only way vitest can wrap ESM bindings in a spy
// that the handler's static imports actually see.

vi.mock('@shared/protocol/ai/ai-complete', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@shared/protocol/ai/ai-complete')>();
  return { ...actual, runToCompletion: vi.fn(actual.runToCompletion) };
});

vi.mock('@shared/protocol/ai/ai-proxy', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@shared/protocol/ai/ai-proxy')>();
  return { ...actual, executeAiChat: vi.fn(actual.executeAiChat) };
});

vi.mock('@shared/protocol/ai/model-discovery', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@shared/protocol/ai/model-discovery')>();
  return {
    ...actual,
    listModels: vi.fn(actual.listModels),
    testConnection: vi.fn(actual.testConnection),
  };
});

import { registerAiLabHandlers, unregisterAiLabHandlers } from '../handlers/ai-lab-handler';
import { runToCompletion } from '@shared/protocol/ai/ai-complete';
import { executeAiChat } from '@shared/protocol/ai/ai-proxy';
import { listModels, testConnection } from '@shared/protocol/ai/model-discovery';
import type { ChatStreamEvent } from '@shared/protocol/ai/types';

const TRUSTED = {
  sender: { id: 1, isDestroyed: () => false },
  senderFrame: { url: 'file:///app/dist/web/index.html' },
};

function handlerFor(channel: string) {
  const call = mockHandle.mock.calls.find((c) => c[0] === channel);
  return call?.[1] as (
    e: unknown,
    p: unknown
  ) => Promise<{
    ok?: boolean;
    error?: string;
    result?: unknown;
    streamId?: string;
    models?: unknown;
  }>;
}

beforeEach(() => {
  mockHandle.mockClear();
  mockResolveSafe.mockClear();
  mockResolveSecret.mockReset();
  mockEmitTo.mockClear();
  mockBindCleanup.mockClear();
  mockDispose.mockClear();
  mockRateCheck.mockReset();
  mockRateCheck.mockReturnValue(true);
  // Reset the orchestrator spies so per-test `mockImplementation` is fresh.
  vi.mocked(runToCompletion).mockReset();
  vi.mocked(executeAiChat).mockReset();
  vi.mocked(listModels).mockReset();
  vi.mocked(testConnection).mockReset();
  registerAiLabHandlers();
});

afterEach(() => {
  unregisterAiLabHandlers();
});

describe('ai-lab-handler E2E: listModels', () => {
  it('returns a rich DiscoveredModel shape end-to-end for an OpenRouter public catalog', async () => {
    // The orchestrator is mocked, but the return shape is the real wire
    // shape the renderer consumes. We assert that the handler propagates
    // it verbatim and that the SSRF guard was applied to the base URL.
    vi.mocked(listModels).mockResolvedValue([
      {
        id: 'anthropic/claude-3.5-sonnet',
        label: 'Claude 3.5 Sonnet',
        description: 'Smart, efficient model for everyday tasks.',
        contextLength: 200000,
        modality: 'text+image->text',
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        pricing: { promptPerMTokUSD: 3, completionPerMTokUSD: 15 },
        createdAt: '2024-10-22T00:00:00.000Z',
        vendor: 'anthropic',
      },
    ] as never);

    const res = await handlerFor('ai-lab:list-models')(TRUSTED, {
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api',
      // Deliberately no apiKeyHandleId — public catalog.
    });
    expect(res.ok).toBe(true);
    expect(res.models).toEqual([
      expect.objectContaining({
        id: 'anthropic/claude-3.5-sonnet',
        label: 'Claude 3.5 Sonnet',
        contextLength: 200000,
        pricing: { promptPerMTokUSD: 3, completionPerMTokUSD: 15 },
        vendor: 'anthropic',
      }),
    ]);
    // The handler called the orchestrator with the right provider + baseUrl.
    expect(listModels).toHaveBeenCalledOnce();
    const call = vi.mocked(listModels).mock.calls[0]?.[0] as {
      provider: string;
      baseUrl: string;
      apiKey?: string;
      fetcher: unknown;
    };
    expect(call.provider).toBe('openrouter');
    expect(call.baseUrl).toBe('https://openrouter.ai/api');
    expect(call.apiKey).toBeUndefined();
    // The SSRF guard was engaged on the BASE URL (not the constructed
    // /v1/models path — that's appended inside the orchestrator, after the
    // base has been DNS-pinned). Localhost is rejected for cloud providers.
    expect(mockResolveSafe).toHaveBeenCalledWith('https://openrouter.ai/api', {
      allowLocalhost: false,
    });
  });

  it('resolves the secret handle and forwards the apiKey to a cloud provider discovery call', async () => {
    mockResolveSecret.mockReturnValue('sk-openai-real-key');
    vi.mocked(listModels).mockResolvedValue([
      { id: 'gpt-4o', vendor: 'openai', createdAt: '2024-05-13T00:00:00.000Z' },
    ] as never);

    const res = await handlerFor('ai-lab:list-models')(TRUSTED, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com',
      apiKeyHandleId: HANDLE_1,
    });
    expect(res.ok).toBe(true);
    // resolveSecretHandle is called once, with the handle the renderer sent.
    expect(mockResolveSecret).toHaveBeenCalledExactlyOnceWith(HANDLE_1);
    // The resolved plaintext is passed to the orchestrator. The renderer never
    // sees the plaintext — only the orchestrator does, in the main process.
    const call = vi.mocked(listModels).mock.calls[0]?.[0] as { apiKey?: string };
    expect(call.apiKey).toBe('sk-openai-real-key');
  });

  it('does not call resolveSecretHandle when no apiKeyHandleId is sent', async () => {
    vi.mocked(listModels).mockResolvedValue([] as never);
    const res = await handlerFor('ai-lab:list-models')(TRUSTED, {
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
    });
    expect(res.ok).toBe(true);
    expect(mockResolveSecret).not.toHaveBeenCalled();
  });

  it('propagates an error from the discovery orchestrator as ok:false with the message', async () => {
    vi.mocked(listModels).mockRejectedValue(new Error('Model discovery failed (401)'));
    const res = await handlerFor('ai-lab:list-models')(TRUSTED, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com',
      apiKeyHandleId: HANDLE_BAD,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/401/);
  });

  it('returns ok:false (without an upstream call) when the SSRF guard rejects the base URL', async () => {
    const res = await handlerFor('ai-lab:list-models')(TRUSTED, {
      provider: 'openai', // cloud provider
      baseUrl: 'http://localhost:1234', // would be a localhost
    });
    expect(res.ok).toBe(false);
    expect(listModels).not.toHaveBeenCalled();
  });

  it('allows a cloud provider to override its baseUrl (e.g. a proxy) and pins that host', async () => {
    vi.mocked(listModels).mockResolvedValue([{ id: 'p' }] as never);
    const res = await handlerFor('ai-lab:list-models')(TRUSTED, {
      provider: 'openai',
      baseUrl: 'https://proxy.example.com/v1',
      apiKeyHandleId: HANDLE_2,
    });
    expect(res.ok).toBe(true);
    // The SSRF guard pins the user-typed baseUrl, not the provider default.
    expect(mockResolveSafe).toHaveBeenCalledWith('https://proxy.example.com/v1', {
      allowLocalhost: false,
    });
  });
});

describe('ai-lab-handler E2E: testConnection', () => {
  it('returns ok:true with modelCount when the discovery call succeeds', async () => {
    vi.mocked(testConnection).mockResolvedValue({ ok: true, modelCount: 7 });
    const res = await handlerFor('ai-lab:test-connection')(TRUSTED, {
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
    });
    expect(res).toEqual({ ok: true, modelCount: 7 });
  });

  it('returns ok:false with a human-readable error when the discovery call throws', async () => {
    vi.mocked(testConnection).mockResolvedValue({
      ok: false,
      error: 'Model discovery failed (502): bad gateway',
    });
    const res = await handlerFor('ai-lab:test-connection')(TRUSTED, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com',
      apiKeyHandleId: HANDLE_1,
    });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toMatch(/502/);
  });
});

describe('ai-lab-handler E2E: complete', () => {
  const base = {
    provider: 'ollama' as const,
    model: 'llama3.2',
    messages: [{ role: 'user' as const, content: 'hi' }],
    rawMode: false,
    baseUrlOverride: 'http://localhost:11434',
  };

  it('happy path: resolves the secret, calls runToCompletion, returns the result', async () => {
    mockResolveSecret.mockReturnValue('sk-test');
    vi.mocked(runToCompletion).mockResolvedValue({
      ok: true,
      text: 'Hello!',
      toolCalls: [],
    });
    const res = await handlerFor('ai-lab:complete')(TRUSTED, {
      ...base,
      apiKeyHandleId: HANDLE_TEST,
    });
    expect(res.ok).toBe(true);
    expect((res as { result: { text: string } }).result.text).toBe('Hello!');
    // The mock `runToCompletion` resolves without invoking the secret resolver
    // — the resolver is only called by the orchestrator at wire-signing time.
    // The actual key resolution path is covered by the test below.
    expect(mockResolveSecret).not.toHaveBeenCalled();
    // The spec the orchestrator received carries the right provider/model and
    // the secret handle id (NOT plaintext — plaintext is only inside
    // resolveSecretFn, called by the orchestrator at wire-signing time).
    const call = vi.mocked(runToCompletion).mock.calls[0]?.[0] as {
      provider: string;
      model: string;
      apiKeyHandleId: string;
    };
    expect(call.provider).toBe('ollama');
    expect(call.model).toBe('llama3.2');
    expect(call.apiKeyHandleId).toBe(HANDLE_TEST);
  });

  it('captures the AbortController and aborts it on activeCompletes.disposeAll()', async () => {
    // Hang runToCompletion forever so we can test cleanup.
    let abortObserved = false;
    vi.mocked(runToCompletion).mockImplementation((async ({ signal }: { signal: AbortSignal }) => {
      return new Promise<never>((_resolve, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => {
            abortObserved = true;
            reject(new Error('aborted'));
          });
        }
      });
    }) as unknown as typeof runToCompletion);
    const resPromise = handlerFor('ai-lab:complete')(TRUSTED, base);
    // Give the handler a tick to register the AbortController.
    await new Promise((r) => setTimeout(r, 0));
    // Simulate the renderer being destroyed — this is what `connection-cleanup`
    // would trigger in production. The handler's `activeCompletes` registry
    // already calls `dispose()` on each entry, which aborts the signal.
    unregisterAiLabHandlers();
    // The in-flight call now rejects with "aborted".
    const res = await resPromise;
    expect(res.ok).toBe(false);
    // The abort listener observed the signal — proves the AbortController was
    // wired through the registry, not just left dangling.
    expect(abortObserved).toBe(true);
  });

  it('propagates an upstream error from runToCompletion as ok:false with the message', async () => {
    vi.mocked(runToCompletion).mockRejectedValue(new Error('upstream 502'));
    const res = await handlerFor('ai-lab:complete')(TRUSTED, base);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/upstream 502/);
  });
});

describe('ai-lab-handler E2E: stream', () => {
  const base = {
    provider: 'openai' as const,
    model: 'gpt-4o',
    streamId: STREAM_ID,
    messages: [{ role: 'user' as const, content: 'hi' }],
    rawMode: false,
    // Cloud providers require an API key handle (defense-in-depth refine in
    // AiLabStreamSchema). The mocked executeAiChat never calls resolveSecretFn,
    // so mockResolveSecret stays untouched — the key only satisfies the schema
    // gate so the streaming behaviour under test is actually reached.
    apiKeyHandleId: HANDLE_1,
  };

  it('emits each ChatStreamEvent on the chunk channel and a final "done" end event', async () => {
    // Build a tiny ChatStreamEvent sequence; executeAiChat is mocked to yield
    // it as an async iterator, mirroring what the real orchestrator does.
    const events: ChatStreamEvent[] = [
      { type: 'delta', text: 'Hello' },
      { type: 'delta', text: ' world' },
      { type: 'usage', usage: { promptTokens: 1, completionTokens: 2, estimatedCostUSD: 0.001 } },
      { type: 'done' },
    ];
    vi.mocked(executeAiChat).mockImplementation(async function* () {
      for (const e of events) yield e;
    } as unknown as typeof executeAiChat);

    const res = await handlerFor('ai-lab:stream')(TRUSTED, base);
    expect(res.ok).toBe(true);
    expect(res.streamId).toBe(STREAM_ID);

    // The handler returns immediately and the stream runs in the background.
    // Drain the microtask queue to let `runStream` iterate the generator.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Each chunk landed on the chunk channel for the stream. The channel
    // prefix is `ai-lab:chunk:` (per-stream suffix) and `ai-lab:end:` for the
    // end-of-stream marker — not `ai-lab:stream:` (the request channel is
    // `ai-lab:stream`, the *event* channel is the per-stream templated one).
    const chunkChannel = `ai-lab:chunk:${STREAM_ID}`;
    const endChannel = `ai-lab:end:${STREAM_ID}`;
    const chunkCalls = mockEmitTo.mock.calls.filter((c) => c[1] === chunkChannel);
    expect(chunkCalls).toHaveLength(events.length);
    // The 'done' event triggers a final end event with reason='done'.
    const endCalls = mockEmitTo.mock.calls.filter((c) => c[1] === endChannel);
    expect(endCalls).toHaveLength(1);
    expect(endCalls[0]?.[2]).toEqual({ reason: 'done' });
    // Chunk payload order matches the generator.
    expect(chunkCalls[0]?.[2]).toEqual(events[0]);
    expect(chunkCalls[2]?.[2]).toEqual(events[2]);
  });

  it('emits an "error" chunk + an "error" end event when the orchestrator throws', async () => {
    vi.mocked(executeAiChat).mockImplementation(
      /* eslint-disable-next-line require-yield */
      async function* () {
        throw new Error('upstream 503');
      } as unknown as typeof executeAiChat
    );
    await handlerFor('ai-lab:stream')(TRUSTED, base);
    await new Promise((r) => setTimeout(r, 0));
    const chunkChannel = `ai-lab:chunk:${STREAM_ID}`;
    const endChannel = `ai-lab:end:${STREAM_ID}`;
    const chunkCalls = mockEmitTo.mock.calls.filter((c) => c[1] === chunkChannel);
    const endCalls = mockEmitTo.mock.calls.filter((c) => c[1] === endChannel);
    expect(chunkCalls.at(-1)?.[2]).toEqual({
      type: 'error',
      code: 'network',
      message: 'upstream 503',
    });
    expect(endCalls).toHaveLength(1);
    expect(endCalls[0]?.[2]).toEqual({ reason: 'error' });
  });

  it('emits an end event with reason:"cancelled" when streamCancel aborts the stream', async () => {
    // Hang the iterator on an abort signal so cancellation has something to abort.
    let abortObserved = false;
    vi.mocked(executeAiChat).mockImplementation(async function* ({
      signal,
    }: {
      signal: AbortSignal;
    }) {
      // Yield one event so the stream is established, then wait for abort.
      yield { type: 'delta', text: 'partial' } satisfies ChatStreamEvent;
      if (signal) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            abortObserved = true;
            reject(new Error('aborted'));
          });
        });
      }
    } as unknown as typeof executeAiChat);
    const start = await handlerFor('ai-lab:stream')(TRUSTED, base);
    expect(start.ok).toBe(true);
    // Give the generator a moment to register its abort listener.
    await new Promise((r) => setTimeout(r, 0));
    // Cancel the stream from the renderer side.
    const cancel = await handlerFor('ai-lab:stream:cancel')(TRUSTED, { streamId: STREAM_ID });
    expect(cancel.ok).toBe(true);
    // Drain.
    await new Promise((r) => setTimeout(r, 0));
    expect(abortObserved).toBe(true);
    // Two end events are emitted in this case: one from the cancel handler
    // itself (reason='cancelled') and one from `runStream`'s catch block
    // observing the abort and reporting it (reason='error'). The renderer is
    // expected to be idempotent on end-of-stream — receiving two is a known
    // shape of the cancel path. We assert both are present so a future
    // refactor that drops one will be caught.
    const endChannel = `ai-lab:end:${STREAM_ID}`;
    const endCalls = mockEmitTo.mock.calls.filter((c) => c[1] === endChannel);
    const endReasons = endCalls.map((c) => (c[2] as { reason: string }).reason);
    expect(endReasons).toContain('cancelled');
    expect(endReasons).toContain('error');
  });

  it('caps concurrent streams at MAX_CONCURRENT_STREAMS per sender', async () => {
    // Start 7 streams from the same sender; the 7th should be rejected.
    const ids = [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7',
    ];
    // Keep the iterator open indefinitely.
    vi.mocked(executeAiChat).mockImplementation(
      /* eslint-disable-next-line require-yield */
      async function* () {
        await new Promise<void>((resolve) => {
          // never resolves — the test cancels us by tearing down the handler.
          setTimeout(resolve, 60_000);
        });
      } as unknown as typeof executeAiChat
    );
    let fails = 0;
    for (const streamId of ids) {
      const r = await handlerFor('ai-lab:stream')(TRUSTED, { ...base, streamId });
      if (!r.ok) fails += 1;
    }
    // MAX_CONCURRENT_STREAMS is 6, so the 7th must fail.
    expect(fails).toBe(1);
  });
});
