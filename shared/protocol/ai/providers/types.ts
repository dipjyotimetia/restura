// shared/protocol/ai/providers/types.ts
import type { Provider, ChatStreamEvent } from '@shared/protocol/ai/types';

export interface ModelInfo {
  id: string;                       // "gpt-4o-mini"
  label: string;                    // "GPT-4o mini"
  contextWindow: number;            // tokens
  inputUSDPerMTok: number;          // pricing snapshot, refresh quarterly
  outputUSDPerMTok: number;
}

/**
 * Stateful per-request stream decoder. Each provider implements this against
 * its native SSE event shape and yields normalised ChatStreamEvent.
 */
export interface StreamDecoder {
  /** Feed raw SSE event data (the part after `data: `). Returns 0+ events. */
  feed(rawSseData: string, eventName?: string): ChatStreamEvent[];
  /** Flush — call once on stream end. Emits trailing `usage` + `done`. */
  flush(): ChatStreamEvent[];
}

export interface ProviderModule {
  readonly provider: Provider;
  readonly models: ModelInfo[];
  createDecoder(model: string): StreamDecoder;
}
