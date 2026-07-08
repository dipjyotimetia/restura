import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { completeLlm, streamLlm, listModels, testConnection } from '../llmClient';
import type { ChatStreamEvent } from '@shared/protocol/ai/types';

// Exercises the IPC bridge by installing a fake window.electron.aiLab. This is
// the path llmClient.test.ts can't reach (it tests the no-Electron guard).

interface Captured {
  chunkCb?: (ev: ChatStreamEvent) => void;
  endCb?: (p: { reason: 'done' | 'cancelled' | 'error' }) => void;
  order: string[];
}

let captured: Captured;
let aiLab: Record<string, ReturnType<typeof vi.fn>>;

function installBridge() {
  captured = { order: [] };
  aiLab = {
    complete: vi.fn(async () => ({ ok: true, result: { ok: true, text: 'hi', toolCalls: [] } })),
    stream: vi.fn(async () => {
      captured.order.push('stream');
      return { ok: true, streamId: 'sid' };
    }),
    cancelStream: vi.fn(async () => ({ ok: true })),
    listModels: vi.fn(async () => ({ ok: true, models: [{ id: 'm' }] })),
    testConnection: vi.fn(async () => ({ ok: true, modelCount: 1 })),
    onChunk: vi.fn((_id: string, cb: (ev: ChatStreamEvent) => void) => {
      captured.order.push('onChunk');
      captured.chunkCb = cb;
      return () => captured.order.push('offChunk');
    }),
    onEnd: vi.fn((_id: string, cb: (p: { reason: 'done' | 'cancelled' | 'error' }) => void) => {
      captured.order.push('onEnd');
      captured.endCb = cb;
      return () => captured.order.push('offEnd');
    }),
  };
  (window as unknown as { electron: unknown }).electron = { isElectron: true, aiLab };
}

const SPEC = {
  provider: 'ollama' as const,
  model: 'm',
  messages: [{ role: 'user' as const, content: 'hi' }],
  rawMode: true,
};

describe('llmClient bridge', () => {
  beforeEach(installBridge);
  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('completeLlm returns the result on success', async () => {
    const res = await completeLlm(SPEC);
    expect(res.text).toBe('hi');
    expect(aiLab.complete).toHaveBeenCalledOnce();
  });

  it('completeLlm throws on an error response', async () => {
    aiLab.complete!.mockResolvedValueOnce({ ok: false, error: 'nope' });
    await expect(completeLlm(SPEC)).rejects.toThrow('nope');
  });

  it('streamLlm subscribes to chunk + end BEFORE invoking stream', async () => {
    await streamLlm(SPEC, { onChunk: () => {}, onEnd: () => {} });
    // onChunk/onEnd must register before the stream() invoke or early events drop.
    expect(captured.order.indexOf('onChunk')).toBeLessThan(captured.order.indexOf('stream'));
    expect(captured.order.indexOf('onEnd')).toBeLessThan(captured.order.indexOf('stream'));
  });

  it('streamLlm forwards chunks and unsubscribes on end', async () => {
    const chunks: ChatStreamEvent[] = [];
    let endReason = '';
    await streamLlm(SPEC, { onChunk: (ev) => chunks.push(ev), onEnd: (r) => (endReason = r) });
    captured.chunkCb?.({ type: 'delta', text: 'abc' });
    captured.endCb?.({ reason: 'done' });
    expect(chunks).toEqual([{ type: 'delta', text: 'abc' }]);
    expect(endReason).toBe('done');
    // Both subscriptions cleaned up after end.
    expect(captured.order).toContain('offChunk');
    expect(captured.order).toContain('offEnd');
  });

  it('streamLlm cancel calls cancelStream', async () => {
    const handle = await streamLlm(SPEC, { onChunk: () => {}, onEnd: () => {} });
    handle.cancel();
    expect(aiLab.cancelStream).toHaveBeenCalledWith({ streamId: handle.streamId });
  });

  it('streamLlm unsubscribes and throws when stream() fails', async () => {
    aiLab.stream!.mockResolvedValueOnce({ ok: false, error: 'boom' });
    await expect(streamLlm(SPEC, { onChunk: () => {}, onEnd: () => {} })).rejects.toThrow('boom');
    expect(captured.order).toContain('offChunk');
    expect(captured.order).toContain('offEnd');
  });

  it('listModels / testConnection pass through the bridge', async () => {
    expect(await listModels({ provider: 'ollama', baseUrl: 'http://localhost:11434' })).toEqual({
      ok: true,
      models: [{ id: 'm' }],
    });
    expect(await testConnection({ provider: 'ollama', baseUrl: 'http://localhost:11434' })).toEqual(
      { ok: true, modelCount: 1 }
    );
  });

  it('forwards a plaintext apiKey for pre-add discovery (regression: was silently dropped)', async () => {
    // The add-provider form types a key but hasn't minted a handle yet —
    // discovery must carry the plaintext key over IPC or key-required
    // providers (OpenAI / Anthropic / HuggingFace) would 401.
    await listModels({
      provider: 'huggingface',
      baseUrl: 'https://router.huggingface.co',
      apiKey: 'hf_plaintext',
    });
    expect(aiLab.listModels).toHaveBeenCalledWith({
      provider: 'huggingface',
      baseUrl: 'https://router.huggingface.co',
      apiKey: 'hf_plaintext',
    });
  });
});
