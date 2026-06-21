import type { ChatStreamEvent } from '@shared/protocol/ai/types';
import type { ModelInfo, ProviderModule, StreamDecoder } from './types';

const MODELS: ModelInfo[] = [
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    inputUSDPerMTok: 1.0,
    outputUSDPerMTok: 5.0,
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    contextWindow: 200_000,
    inputUSDPerMTok: 3.0,
    outputUSDPerMTok: 15.0,
  },
  {
    id: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    contextWindow: 200_000,
    inputUSDPerMTok: 15.0,
    outputUSDPerMTok: 75.0,
  },
];

function modelFor(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const info = modelFor(model);
  if (!info) return 0;
  return (
    (inputTokens / 1_000_000) * info.inputUSDPerMTok +
    (outputTokens / 1_000_000) * info.outputUSDPerMTok
  );
}

class AnthropicDecoder implements StreamDecoder {
  private buffered: ChatStreamEvent[] = [];
  private inputTokens = 0;
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
      message?: { usage?: { input_tokens?: number; output_tokens?: number } };
      delta?: { text?: string; type?: string; partial_json?: string };
      usage?: { input_tokens?: number; output_tokens?: number };
      error?: { message?: string };
    };
    const evt = eventName ?? p.type;
    switch (evt) {
      case 'message_start':
        if (p.message?.usage?.input_tokens != null) this.inputTokens = p.message.usage.input_tokens;
        if (p.message?.usage?.output_tokens != null)
          this.outputTokens = p.message.usage.output_tokens;
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
        if (p.usage?.output_tokens != null) this.outputTokens = p.usage.output_tokens;
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

  flush(): ChatStreamEvent[] {
    if (this.inputTokens > 0 || this.outputTokens > 0) {
      this.buffered.push({
        type: 'usage',
        usage: {
          promptTokens: this.inputTokens,
          completionTokens: this.outputTokens,
          estimatedCostUSD: estimateCost(this.model, this.inputTokens, this.outputTokens),
        },
      });
      this.inputTokens = 0;
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
