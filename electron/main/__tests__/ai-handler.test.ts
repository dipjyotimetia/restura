import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockRemoveHandler = vi.hoisted(() => vi.fn());
const mockResolveSecret = vi.hoisted(() => vi.fn());
const mockAssertSafe = vi.hoisted(() => vi.fn(async () => undefined));
const mockEmitTo = vi.hoisted(() => vi.fn());
const mockBindCleanup = vi.hoisted(() => vi.fn());
const mockDispose = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: mockRemoveHandler },
}));
vi.mock('../secret-handle-store', () => ({ resolveSecretHandle: mockResolveSecret }));
vi.mock('../dns-guard', () => ({ assertUrlHostnameSafe: mockAssertSafe }));
vi.mock('../ipc-utils', () => ({ emitTo: mockEmitTo }));
vi.mock('../connection-cleanup', () => ({
  bindRendererCleanup: mockBindCleanup,
  disposeByOwner: mockDispose,
}));

import { registerAiHandlers, unregisterAiHandlers, __testing } from '../ai-handler';

describe('ai-handler', () => {
  beforeEach(() => {
    mockHandle.mockClear();
    mockRemoveHandler.mockClear();
    mockResolveSecret.mockReset();
    mockEmitTo.mockClear();
    mockBindCleanup.mockClear();
    mockDispose.mockClear();
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
    const fakeEvent = { sender: { id: 1, isDestroyed: () => false } };
    const result = (await handler(fakeEvent, { not: 'valid' })) as { ok?: boolean };
    expect(result.ok).toBe(false);
  });

  it('resolveSecretFn returns plaintext from handle store', async () => {
    mockResolveSecret.mockReturnValue('sk-plaintext');
    expect(await __testing.resolveSecretFn('handle-x')).toBe('sk-plaintext');
  });

  it('resolveSecretFn returns undefined if handle absent', async () => {
    mockResolveSecret.mockReturnValue(undefined);
    expect(await __testing.resolveSecretFn('handle-x')).toBeUndefined();
  });
});
