import type { ChatStreamEvent } from '@shared/protocol/ai/types';
import { estimateCostUSD, type ModelInfo, type ProviderModule, type StreamDecoder } from './types';

// Pricing snapshot from platform.claude.com/docs/en/about-claude/pricing
// (checked 2026-09-30). 5-minute cache writes are 1.25x input; reads are 0.1x
// (0.05x on Opus 5.5, 0.025x on Fable 5.1).
const MODELS: ModelInfo[] = [
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    inputUSDPerMTok: 1.0,
    outputUSDPerMTok: 5.0,
    cacheReadUSDPerMTok: 0.1,
    cacheWriteUSDPerMTok: 1.25,
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    contextWindow: 1_000_000,
    inputUSDPerMTok: 2.0,
    outputUSDPerMTok: 10.0,
    cacheReadUSDPerMTok: 0.2,
    cacheWriteUSDPerMTok: 2.5,
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    contextWindow: 1_000_000,
    inputUSDPerMTok: 4.0,
    outputUSDPerMTok: 20.0,
    cacheReadUSDPerMTok: 0.2,
    cacheWriteUSDPerMTok: 5.0,
  },
  {
    id: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    contextWindow: 1_000_000,
    inputUSDPerMTok: 10.0,
    outputUSDPerMTok: 50.0,
    cacheReadUSDPerMTok: 0.25,
    cacheWriteUSDPerMTok: 12.5,
  },
];

function modelFor(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

class AnthropicDecoder implements StreamDecoder {
  private buffered: ChatStreamEvent[] = [];
  // `input_tokens` from Anthropic EXCLUDES cache reads/writes; tracked apart so
  // cost uses each rate and `promptTokens` reports the true total.
  private inputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private outputTokens = 0;
  private finished = false;
  // Tool-use content blocks, keyed by stream `index`. Anthropic streams the
  // arguments JSON in `input_json_delta` fragments; we accumulate and emit a
  // single tool_call on content_block_stop.
  private toolBlocks = new Map<number, { id: string; name: string; json: string }>();

  constructor(private readonly model: string) {}

  feed(rawData: string, eventName?: string): ChatStreamEvent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      this.buffered.push({ type: 'error', code: 'parse', message: 'Malformed JSON in SSE event' });
      return this.drain();
    }
    const p = parsed as {
      type?: string;
      index?: number;
      content_block?: { type?: string; id?: string; name?: string };
      message?: { usage?: AnthropicUsage };
      delta?: { text?: string; type?: string; partial_json?: string };
      usage?: AnthropicUsage;
      error?: { message?: string };
    };
    const evt = eventName ?? p.type;
    switch (evt) {
      case 'message_start':
        this.absorbUsage(p.message?.usage);
        break;
      case 'content_block_start':
        if (
          p.content_block?.type === 'tool_use' &&
          p.content_block.id &&
          p.content_block.name &&
          p.index != null
        ) {
          this.toolBlocks.set(p.index, {
            id: p.content_block.id,
            name: p.content_block.name,
            json: '',
          });
        }
        break;
      case 'content_block_delta':
        if (
          p.delta?.type === 'text_delta' &&
          typeof p.delta.text === 'string' &&
          p.delta.text.length > 0
        ) {
          this.buffered.push({ type: 'delta', text: p.delta.text });
        } else if (
          p.delta?.type === 'input_json_delta' &&
          typeof p.delta.partial_json === 'string' &&
          p.index != null
        ) {
          const block = this.toolBlocks.get(p.index);
          if (block) block.json += p.delta.partial_json;
        }
        break;
      case 'content_block_stop':
        if (p.index != null) {
          const block = this.toolBlocks.get(p.index);
          if (block) {
            this.buffered.push({
              type: 'tool_call',
              id: block.id,
              name: block.name,
              input: block.json || '{}',
            });
            this.toolBlocks.delete(p.index);
          }
        }
        break;
      case 'message_delta':
        this.absorbUsage(p.usage);
        break;
      case 'message_stop':
        this.finished = true;
        break;
      case 'error':
        this.buffered.push({
          type: 'error',
          code: 'provider',
          message: p.error?.message ?? 'Provider error',
        });
        this.finished = true;
        break;
      default:
        break;
    }
    return this.drain();
  }

  /** Later events may carry only some fields; keep the last value seen for each. */
  private absorbUsage(u: AnthropicUsage | undefined): void {
    if (!u) return;
    if (u.input_tokens != null) this.inputTokens = u.input_tokens;
    if (u.cache_read_input_tokens != null) this.cacheReadTokens = u.cache_read_input_tokens;
    if (u.cache_creation_input_tokens != null)
      this.cacheWriteTokens = u.cache_creation_input_tokens;
    if (u.output_tokens != null) this.outputTokens = u.output_tokens;
  }

  flush(): ChatStreamEvent[] {
    const promptTokens = this.inputTokens + this.cacheReadTokens + this.cacheWriteTokens;
    if (promptTokens > 0 || this.outputTokens > 0) {
      this.buffered.push({
        type: 'usage',
        usage: {
          promptTokens,
          completionTokens: this.outputTokens,
          estimatedCostUSD: estimateCostUSD(modelFor(this.model), {
            input: this.inputTokens,
            cacheRead: this.cacheReadTokens,
            cacheWrite: this.cacheWriteTokens,
            output: this.outputTokens,
          }),
        },
      });
      this.inputTokens = 0;
      this.cacheReadTokens = 0;
      this.cacheWriteTokens = 0;
      this.outputTokens = 0;
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

export const anthropicModule: ProviderModule = {
  provider: 'anthropic',
  models: MODELS,
  createDecoder: (model) => new AnthropicDecoder(model),
};
