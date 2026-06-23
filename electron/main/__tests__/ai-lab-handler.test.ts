import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockRemoveHandler = vi.hoisted(() => vi.fn());
const mockResolveSecret = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const mockBindCleanup = vi.hoisted(() => vi.fn());
const mockDispose = vi.hoisted(() => vi.fn());
const mockRunToCompletion = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, text: 'hi', toolCalls: [] }))
);
const mockListModels = vi.hoisted(() => vi.fn(async () => [{ id: 'llama3.2' }]));
const mockTestConnection = vi.hoisted(() => vi.fn(async () => ({ ok: true, modelCount: 1 })));
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
vi.mock('@shared/protocol/ai/ai-proxy', () => ({ executeAiChat: vi.fn() }));
vi.mock('@shared/protocol/ai/model-discovery', () => ({
  listModels: mockListModels,
  testConnection: mockTestConnection,
}));

import { registerAiLabHandlers, unregisterAiLabHandlers } from '../handlers/ai-lab-handler';

const TRUSTED = {
  sender: { id: 1, isDestroyed: () => false },
  senderFrame: { url: 'file:///app/dist/web/index.html' },
};

function handlerFor(channel: string) {
  const call = mockHandle.mock.calls.find((c) => c[0] === channel);
  return call?.[1] as (e: unknown, p: unknown) => Promise<{ ok?: boolean; error?: string }>;
}

describe('ai-lab-handler', () => {
  beforeEach(() => {
    mockHandle.mockClear();
    mockResolveSafe.mockClear();
    mockResolveSecret.mockReset();
    mockRunToCompletion.mockClear();
    mockListModels.mockClear();
    mockTestConnection.mockClear();
    mockRateCheck.mockReset();
    mockRateCheck.mockReturnValue(true);
    registerAiLabHandlers();
  });
  afterEach(() => unregisterAiLabHandlers());

  it('registers all five AI Lab channels', () => {
    const channels = mockHandle.mock.calls.map((c) => c[0]);
    expect(channels).toEqual(
      expect.arrayContaining([
        'ai-lab:complete',
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
    const base = { model: 'm', messages: [{ role: 'user', content: 'hi' }], rawMode: false };

    it('rejects a cloud provider whose base URL override targets localhost', async () => {
      const res = await handlerFor('ai-lab:complete')(TRUSTED, {
        ...base,
        provider: 'openai',
        baseUrlOverride: 'http://localhost:8080',
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
});
