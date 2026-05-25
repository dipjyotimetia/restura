import type { ChatStreamEvent } from '@shared/protocol/ai/types';
import type { ModelInfo, ProviderModule, StreamDecoder } from './types';

const MODELS: ModelInfo[] = [
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', contextWindow: 128_000, inputUSDPerMTok: 0.15, outputUSDPerMTok: 0.60 },
  { id: 'gpt-4o', label: 'GPT-4o', contextWindow: 128_000, inputUSDPerMTok: 2.50, outputUSDPerMTok: 10.00 },
];

function modelFor(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const info = modelFor(model);
  if (!info) return 0;
  return (
    (promptTokens / 1_000_000) * info.inputUSDPerMTok +
    (completionTokens / 1_000_000) * info.outputUSDPerMTok
  );
}

/**
 * OpenAI chunked Chat Completions format:
 *   data: {"choices":[{"delta":{"content":"…"}, "finish_reason":null}], "usage":{…}?}
 *   …
 *   data: [DONE]
 */
class OpenAIDecoder implements StreamDecoder {
  private buffered: ChatStreamEvent[] = [];
  private pendingUsage: { promptTokens: number; completionTokens: number } | null = null;
  private finished = false;

  constructor(private readonly model: string) {}

  feed(rawData: string): ChatStreamEvent[] {
    if (rawData === '[DONE]') {
      this.finished = true;
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      this.buffered.push({ type: 'error', code: 'parse', message: 'Malformed JSON in SSE event' });
      return this.drain();
    }
    if (!parsed || typeof parsed !== 'object') return [];
    const p = parsed as {
      choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    if (p.error?.message) {
      this.buffered.push({ type: 'error', code: 'provider', message: p.error.message });
    }
    const delta = p.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      this.buffered.push({ type: 'delta', text: delta });
    }
    if (p.usage?.prompt_tokens != null && p.usage.completion_tokens != null) {
      this.pendingUsage = {
        promptTokens: p.usage.prompt_tokens,
        completionTokens: p.usage.completion_tokens,
      };
    }
    return this.drain();
  }

  flush(): ChatStreamEvent[] {
    if (this.pendingUsage) {
      this.buffered.push({
        type: 'usage',
        usage: {
          ...this.pendingUsage,
          estimatedCostUSD: estimateCost(this.model, this.pendingUsage.promptTokens, this.pendingUsage.completionTokens),
        },
      });
      this.pendingUsage = null;
    }
    if (this.finished || this.buffered.length > 0) {
      this.buffered.push({ type: 'done' });
    }
    return this.drain();
  }

  private drain(): ChatStreamEvent[] {
    const out = this.buffered;
    this.buffered = [];
    return out;
  }
}

export const openaiModule: ProviderModule = {
  provider: 'openai',
  models: MODELS,
  createDecoder: (model) => new OpenAIDecoder(model),
};
