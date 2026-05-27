import type { ChatStreamEvent } from '@shared/protocol/ai/types';
import type { ModelInfo, ProviderModule, StreamDecoder } from './types';

const MODELS: ModelInfo[] = [
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', contextWindow: 128_000, inputUSDPerMTok: 0.15, outputUSDPerMTok: 0.60 },
  { id: 'gpt-4o', label: 'GPT-4o', contextWindow: 128_000, inputUSDPerMTok: 2.50, outputUSDPerMTok: 10.00 },
];

function estimateCost(
  models: ModelInfo[],
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const info = models.find((m) => m.id === model);
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
 *
 * `models` is supplied by the owning provider so cost is estimated against the
 * right price table. OpenRouter reuses this decoder verbatim (same wire format)
 * but passes its OWN model list — otherwise OpenRouter's slash-namespaced ids
 * (`anthropic/claude-…`) would never match and cost would always read $0.
 */
class OpenAIDecoder implements StreamDecoder {
  private buffered: ChatStreamEvent[] = [];
  private pendingUsage: { promptTokens: number; completionTokens: number } | null = null;
  private finished = false;
  // Tool calls stream as delta.tool_calls[]; id/name arrive first, arguments
  // accumulate across chunks. Keyed by `index`; emitted on flush().
  private toolCalls = new Map<number, { id: string; name: string; args: string }>();

  constructor(
    private readonly model: string,
    private readonly models: ModelInfo[],
  ) {}

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
      choices?: Array<{
        delta?: {
          content?: string;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    if (p.error?.message) {
      this.buffered.push({ type: 'error', code: 'provider', message: p.error.message });
      this.finished = true;
    }
    const delta = p.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      this.buffered.push({ type: 'delta', text: delta });
    }
    const toolDeltas = p.choices?.[0]?.delta?.tool_calls;
    if (toolDeltas) {
      for (const td of toolDeltas) {
        const idx = td.index ?? 0;
        const existing = this.toolCalls.get(idx) ?? { id: '', name: '', args: '' };
        if (td.id) existing.id = td.id;
        if (td.function?.name) existing.name = td.function.name;
        if (td.function?.arguments) existing.args += td.function.arguments;
        this.toolCalls.set(idx, existing);
      }
    }
    // A non-null finish_reason terminates the completion. Mark finished so a
    // stream that closes without a trailing `[DONE]` (some proxies / self-hosted
    // gateways omit it) still emits a `done` event in flush().
    if (p.choices?.[0]?.finish_reason != null) {
      this.finished = true;
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
    // Emit completed tool calls before usage/done, in index order.
    if (this.toolCalls.size > 0) {
      for (const [, tc] of [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
        if (tc.id && tc.name) {
          this.buffered.push({ type: 'tool_call', id: tc.id, name: tc.name, input: tc.args || '{}' });
        }
      }
      this.toolCalls.clear();
    }
    if (this.pendingUsage) {
      this.buffered.push({
        type: 'usage',
        usage: {
          ...this.pendingUsage,
          estimatedCostUSD: estimateCost(
            this.models,
            this.model,
            this.pendingUsage.promptTokens,
            this.pendingUsage.completionTokens,
          ),
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

/**
 * Build an OpenAI-wire-format decoder that estimates cost against `models`.
 * Shared with OpenRouter (which passes its own price table).
 */
export function createOpenAiStyleDecoder(model: string, models: ModelInfo[]): StreamDecoder {
  return new OpenAIDecoder(model, models);
}

export const openaiModule: ProviderModule = {
  provider: 'openai',
  models: MODELS,
  createDecoder: (model) => createOpenAiStyleDecoder(model, MODELS),
};
