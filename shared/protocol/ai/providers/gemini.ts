import type { ChatStreamEvent } from '@shared/protocol/ai/types';
import type { ModelInfo, ProviderModule, StreamDecoder } from './types';

/**
 * Gemini API `models/{model}:streamGenerateContent?alt=sse`. Every SSE event
 * is a full GenerateContentResponse chunk: text parts stream as deltas,
 * function calls arrive whole (no argument streaming), and `usageMetadata`
 * carries running totals, so the last one seen wins.
 *
 * Gemini prices by tier and context length; there is no static table here,
 * so cost reads as unknown (pricingKnown=false).
 */
const MODELS: ModelInfo[] = [];

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { id?: string; name?: string; args?: unknown };
}

interface GeminiChunk {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

class GeminiDecoder implements StreamDecoder {
  private buffered: ChatStreamEvent[] = [];
  private usage: { prompt: number; completion: number; cached: number } | null = null;
  private finished = false;
  private callIndex = 0;

  feed(rawData: string): ChatStreamEvent[] {
    let chunk: GeminiChunk;
    try {
      chunk = JSON.parse(rawData) as GeminiChunk;
    } catch {
      this.buffered.push({ type: 'error', code: 'parse', message: 'Malformed JSON in SSE event' });
      return this.drain();
    }
    if (!chunk || typeof chunk !== 'object') return [];
    if (chunk.error?.message) {
      this.buffered.push({ type: 'error', code: 'provider', message: chunk.error.message });
      this.finished = true;
      return this.drain();
    }
    if (chunk.promptFeedback?.blockReason) {
      this.buffered.push({
        type: 'error',
        code: 'provider',
        message: `Gemini blocked the prompt: ${chunk.promptFeedback.blockReason}`,
      });
      this.finished = true;
    }
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      // Thought summaries are reasoning, not the visible answer.
      if (typeof part.text === 'string' && part.text.length > 0 && !part.thought) {
        this.buffered.push({ type: 'delta', text: part.text });
      }
      if (part.functionCall?.name) {
        this.callIndex += 1;
        this.buffered.push({
          type: 'tool_call',
          // Older models omit the id; tool results are matched back by name.
          id: part.functionCall.id || `gemini-call-${this.callIndex}`,
          name: part.functionCall.name,
          input: JSON.stringify(part.functionCall.args ?? {}),
        });
      }
    }
    if (candidate?.finishReason) this.finished = true;
    const meta = chunk.usageMetadata;
    if (meta?.promptTokenCount != null) {
      this.usage = {
        prompt: meta.promptTokenCount,
        // Thinking tokens bill as output.
        completion: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
        cached: Math.min(meta.cachedContentTokenCount ?? 0, meta.promptTokenCount),
      };
    }
    return this.drain();
  }

  flush(): ChatStreamEvent[] {
    if (this.usage) {
      this.buffered.push({
        type: 'usage',
        usage: {
          promptTokens: this.usage.prompt,
          completionTokens: this.usage.completion,
          ...(this.usage.cached > 0 ? { cacheReadTokens: this.usage.cached } : {}),
          estimatedCostUSD: 0,
        },
      });
      this.usage = null;
    }
    if (this.finished || this.buffered.length > 0) this.buffered.push({ type: 'done' });
    return this.drain();
  }

  private drain(): ChatStreamEvent[] {
    const out = this.buffered;
    this.buffered = [];
    return out;
  }
}

export const geminiModule: ProviderModule = {
  provider: 'gemini',
  models: MODELS,
  createDecoder: () => new GeminiDecoder(),
};
