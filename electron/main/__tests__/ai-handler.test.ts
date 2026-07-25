import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockRemoveHandler = vi.hoisted(() => vi.fn());
const mockResolveSecret = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const mockBindCleanup = vi.hoisted(() => vi.fn());
const mockDispose = vi.hoisted(() => vi.fn());
const mockMakePinnedFetcher = vi.hoisted(() => vi.fn(async () => vi.fn()));
const mockResolveBaseUrl = vi.hoisted(() => vi.fn(() => 'https://api.openai.com/v1'));
const mockExecuteAiChat = vi.hoisted(() => vi.fn());

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
vi.mock('@shared/protocol/ai/ai-proxy', () => ({ executeAiChat: mockExecuteAiChat }));

import { __testing, registerAiHandlers, unregisterAiHandlers } from '../handlers/ai-handler';

const STREAM_ID = '00000000-0000-4000-8000-000000000000';
const CHAT_REQUEST = {
  streamId: STREAM_ID,
  provider: 'openai',
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
  apiKeyHandleId: '00000000-0000-4000-8000-000000000001',
  rawMode: false,
};
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

function handlerFor(channel: string) {
  const call = mockHandle.mock.calls.find((candidate) => candidate[0] === channel);
  return call?.[1] as (event: unknown, payload: unknown) => Promise<Record<string, unknown>>;
}

function deferChatStream() {
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
    mockExecuteAiChat.mockReset();
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

  it('treats another renderer chat ID as missing without crossing ownership', async () => {
    const ownerStream = deferChatStream();
    const otherStream = deferChatStream();
    await expect(handlerFor('ai:chat')(TRUSTED, CHAT_REQUEST)).resolves.toMatchObject({
      ok: true,
      streamId: STREAM_ID,
    });
    await vi.waitFor(() => expect(ownerStream.getSignal()).toBeDefined());

    await expect(handlerFor('ai:chat')(OTHER_SENDER, CHAT_REQUEST)).resolves.toEqual({
      ok: true,
      streamId: STREAM_ID,
    });
    await vi.waitFor(() => expect(otherStream.getSignal()).toBeDefined());
    expect(ownerStream.getSignal()?.aborted).toBe(false);

    const missingCancel = await handlerFor('ai:chat:cancel')(THIRD_SENDER, {
      streamId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    await expect(
      handlerFor('ai:chat:cancel')(THIRD_SENDER, { streamId: STREAM_ID })
    ).resolves.toEqual(missingCancel);
    expect(missingCancel).toEqual({ ok: true, alreadyDone: true });
    expect(ownerStream.getSignal()?.aborted).toBe(false);
    expect(otherStream.getSignal()?.aborted).toBe(false);

    await expect(handlerFor('ai:chat:cancel')(TRUSTED, { streamId: STREAM_ID })).resolves.toEqual({
      ok: true,
    });
    expect(ownerStream.getSignal()?.aborted).toBe(true);
    expect(otherStream.getSignal()?.aborted).toBe(false);
    expect(mockEmitTo).toHaveBeenCalledWith(1, `ai:chat:end:${STREAM_ID}`, {
      reason: 'cancelled',
    });
    await expect(
      handlerFor('ai:chat:cancel')(OTHER_SENDER, { streamId: STREAM_ID })
    ).resolves.toEqual({ ok: true });
    expect(otherStream.getSignal()?.aborted).toBe(true);
    ownerStream.finish();
    otherStream.finish();
  });

  it('ignores a replaced chat late completion without deleting its successor', async () => {
    const firstStream = deferChatStream();
    const secondStream = deferChatStream();
    await handlerFor('ai:chat')(TRUSTED, CHAT_REQUEST);
    await vi.waitFor(() => expect(firstStream.getSignal()).toBeDefined());

    await expect(handlerFor('ai:chat')(TRUSTED, CHAT_REQUEST)).resolves.toMatchObject({
      ok: true,
      streamId: STREAM_ID,
    });
    await vi.waitFor(() => expect(secondStream.getSignal()).toBeDefined());
    expect(firstStream.getSignal()?.aborted).toBe(true);

    mockEmitTo.mockClear();
    firstStream.finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockEmitTo).not.toHaveBeenCalled();

    await expect(handlerFor('ai:chat:cancel')(TRUSTED, { streamId: STREAM_ID })).resolves.toEqual({
      ok: true,
    });
    expect(secondStream.getSignal()?.aborted).toBe(true);
    secondStream.finish();
  });
});
