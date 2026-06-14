import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockRemoveHandler = vi.hoisted(() => vi.fn());
const mockResolveSecret = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const mockBindCleanup = vi.hoisted(() => vi.fn());
const mockDispose = vi.hoisted(() => vi.fn());
const mockMakePinnedFetcher = vi.hoisted(() => vi.fn(async () => vi.fn()));
const mockResolveBaseUrl = vi.hoisted(() => vi.fn(() => 'https://api.openai.com/v1'));

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: mockRemoveHandler },
}));
vi.mock('../security/secret-handle-store', () => ({ resolveSecretHandle: mockResolveSecret }));
vi.mock('../ipc/ipc-utils', () => ({ emitTo: mockEmitTo }));
vi.mock('../ipc/connection-cleanup', () => ({
  bindRendererCleanup: mockBindCleanup,
  disposeByOwner: mockDispose,
}));
vi.mock('../handlers/fetch-fetcher', () => ({ makePinnedFetcher: mockMakePinnedFetcher }));
vi.mock('@shared/protocol/ai/provider-routes', () => ({ resolveBaseUrl: mockResolveBaseUrl }));
vi.mock('@shared/protocol/ai/ai-proxy', () => ({ executeAiChat: vi.fn() }));

import { registerAiHandlers, unregisterAiHandlers, __testing } from '../handlers/ai-handler';

describe('ai-handler', () => {
  beforeEach(() => {
    mockHandle.mockClear();
    mockRemoveHandler.mockClear();
    mockResolveSecret.mockReset();
    mockEmitTo.mockClear();
    mockBindCleanup.mockClear();
    mockDispose.mockClear();
    mockMakePinnedFetcher.mockClear();
    mockResolveBaseUrl.mockClear();
    registerAiHandlers();
  });
  afterEach(() => unregisterAiHandlers());

  it('registers ai:chat and ai:chat:cancel', () => {
    const channels = mockHandle.mock.calls.map((c) => c[0]);
    expect(channels).toContain('ai:chat');
    expect(channels).toContain('ai:chat:cancel');
  });

  it('rejects invalid input', async () => {
    const aiChatCall = mockHandle.mock.calls.find((c) => c[0] === 'ai:chat');
    const handler = aiChatCall?.[1] as (e: unknown, p: unknown) => Promise<unknown>;
    const fakeEvent = {
      sender: { id: 1, isDestroyed: () => false },
      senderFrame: { url: 'file:///app/dist/web/index.html' },
    };
    const result = (await handler(fakeEvent, { not: 'valid' })) as { ok?: boolean };
    expect(result.ok).toBe(false);
  });

  it('rejects calls from an untrusted frame', async () => {
    const aiChatCall = mockHandle.mock.calls.find((c) => c[0] === 'ai:chat');
    const handler = aiChatCall?.[1] as (e: unknown, p: unknown) => Promise<unknown>;
    const untrusted = {
      sender: { id: 1, isDestroyed: () => false },
      senderFrame: { url: 'https://attacker.example' },
    };
    await expect(handler(untrusted, { not: 'valid' })).rejects.toThrow(/untrusted frame/);
  });

  it('resolveSecretFn returns plaintext from handle store', async () => {
    mockResolveSecret.mockReturnValue('sk-plaintext');
    expect(await __testing.resolveSecretFn('handle-x')).toBe('sk-plaintext');
  });

  it('resolveSecretFn returns undefined if handle absent', async () => {
    mockResolveSecret.mockReturnValue(undefined);
    expect(await __testing.resolveSecretFn('handle-x')).toBeUndefined();
  });

  it('builds a cloud-only pinned fetcher (allowLocalhost:false) for a valid chat request', async () => {
    const aiChatCall = mockHandle.mock.calls.find((c) => c[0] === 'ai:chat');
    const handler = aiChatCall?.[1] as (e: unknown, p: unknown) => Promise<{ ok?: boolean }>;
    const trusted = {
      sender: { id: 1, isDestroyed: () => false },
      senderFrame: { url: 'file:///app/dist/web/index.html' },
    };
    const res = await handler(trusted, {
      streamId: '00000000-0000-4000-8000-000000000000',
      provider: 'openai',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      apiKeyHandleId: '00000000-0000-4000-8000-000000000001',
      rawMode: false,
    });
    expect(res.ok).toBe(true);
    // Chat is cloud-only — the localhost SSRF carve-out must never be enabled
    // here. Regression guard on the security-load-bearing flag.
    expect(mockResolveBaseUrl).toHaveBeenCalledWith('openai', undefined);
    expect(mockMakePinnedFetcher).toHaveBeenCalledWith('https://api.openai.com/v1', {
      allowLocalhost: false,
    });
  });
});
