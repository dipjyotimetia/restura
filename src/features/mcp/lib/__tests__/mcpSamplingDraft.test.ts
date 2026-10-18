import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiChatStore } from '@/features/ai/store';
import {
  describeSamplingRequest,
  draftSamplingWithAi,
  samplingDraftProvider,
} from '../mcpSamplingDraft';

type Cb = (event: unknown) => void;

const chunkListeners = new Map<string, Cb>();
const endListeners = new Map<string, Cb>();
const ai = {
  chat: vi.fn(),
  cancel: vi.fn(),
  onChunk: vi.fn((id: string, cb: Cb) => {
    chunkListeners.set(id, cb);
    return () => chunkListeners.delete(id);
  }),
  onEnd: vi.fn((id: string, cb: Cb) => {
    endListeners.set(id, cb);
    return () => endListeners.delete(id);
  }),
};

const PARAMS = {
  systemPrompt: 'Be brief',
  maxTokens: 50,
  temperature: 0.2,
  includeContext: 'thisServer',
  modelPreferences: {
    hints: [{ name: 'claude' }, { bad: true }],
    costPriority: 0.3,
    intelligencePriority: 0.9,
  },
  messages: [
    { role: 'user', content: { type: 'text', text: 'Hello' } },
    { role: 'assistant', content: [{ type: 'image', mimeType: 'image/png', data: 'x' }] },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  chunkListeners.clear();
  endListeners.clear();
  (window as unknown as { electron: unknown }).electron = { isElectron: true, ai };
  useAiChatStore.setState({
    activeProvider: 'anthropic',
    providerConfigs: {
      openai: null,
      anthropic: {
        provider: 'anthropic',
        defaultModel: 'claude-test',
        apiKeyRef: { kind: 'handle', id: '11111111-1111-4111-8111-111111111111' },
      },
      openrouter: null,
      'openai-compatible': null,
    },
  });
});

afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
});

describe('describeSamplingRequest', () => {
  it('normalises untrusted params into a display view', () => {
    expect(describeSamplingRequest(PARAMS)).toEqual({
      systemPrompt: 'Be brief',
      maxTokens: 50,
      temperature: 0.2,
      includeContext: 'thisServer',
      modelHints: ['claude'],
      priorities: [
        { label: 'cost', value: 0.3 },
        { label: 'intelligence', value: 0.9 },
      ],
      messages: [
        { role: 'user', text: 'Hello' },
        { role: 'assistant', text: '[image content image/png omitted]' },
      ],
    });
    expect(describeSamplingRequest(null)).toEqual({ messages: [], modelHints: [], priorities: [] });
  });
});

describe('draftSamplingWithAi', () => {
  it('drafts through the configured AI assistant provider', async () => {
    ai.chat.mockImplementation(async (spec: { streamId: string }) => {
      queueMicrotask(() => {
        chunkListeners.get(spec.streamId)?.({ type: 'delta', text: 'Hi ' });
        chunkListeners.get(spec.streamId)?.({ type: 'delta', text: 'there' });
        endListeners.get(spec.streamId)?.({ reason: 'done' });
      });
      return { ok: true, streamId: spec.streamId };
    });
    const deltas: string[] = [];
    const result = await draftSamplingWithAi(describeSamplingRequest(PARAMS), (text) =>
      deltas.push(text)
    );
    expect(result).toEqual({ ok: true, text: 'Hi there', model: 'claude-test' });
    expect(deltas).toEqual(['Hi ', 'Hi there']);
    expect(ai.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'anthropic',
        model: 'claude-test',
        apiKeyHandleId: '11111111-1111-4111-8111-111111111111',
        rawMode: false,
        maxOutputTokens: 50,
        messages: [
          { role: 'system', content: 'Be brief' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: '[image content image/png omitted]' },
        ],
      })
    );
    expect(samplingDraftProvider()).toEqual({ provider: 'anthropic', model: 'claude-test' });
  });

  it('surfaces provider errors and start failures', async () => {
    ai.chat.mockImplementationOnce(async (spec: { streamId: string }) => {
      queueMicrotask(() => {
        chunkListeners.get(spec.streamId)?.({ type: 'error', code: 'guard', message: 'secret' });
        endListeners.get(spec.streamId)?.({ reason: 'error' });
      });
      return { ok: true, streamId: spec.streamId };
    });
    await expect(draftSamplingWithAi(describeSamplingRequest(PARAMS))).resolves.toEqual({
      ok: false,
      error: 'secret',
    });

    ai.chat.mockResolvedValueOnce({ ok: false, error: 'bad key' });
    await expect(draftSamplingWithAi(describeSamplingRequest(PARAMS))).resolves.toEqual({
      ok: false,
      error: 'bad key',
    });
  });

  it('requires a configured provider and the desktop bridge', async () => {
    useAiChatStore.setState({
      providerConfigs: {
        openai: null,
        anthropic: null,
        openrouter: null,
        'openai-compatible': null,
      },
    });
    expect(samplingDraftProvider()).toBeNull();
    await expect(draftSamplingWithAi(describeSamplingRequest(PARAMS))).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('Configure an AI provider'),
    });
    delete (window as unknown as { electron?: unknown }).electron;
    await expect(draftSamplingWithAi(describeSamplingRequest(PARAMS))).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('desktop'),
    });
  });
});
