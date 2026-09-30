// shared/protocol/ai/providers/types.ts
import type { ChatStreamEvent, Provider } from '@shared/protocol/ai/types';

export interface ModelInfo {
  id: string; // "gpt-6-luna"
  label: string; // "GPT-6 Luna"
  contextWindow: number; // tokens
  inputUSDPerMTok: number; // pricing snapshot, refresh quarterly
  outputUSDPerMTok: number;
  /** Prompt-cache read rate. Omitted → cache reads are billed at the input rate. */
  cacheReadUSDPerMTok?: number;
  /** Prompt-cache write rate (5-minute TTL). Omitted → writes are billed at the input rate. */
  cacheWriteUSDPerMTok?: number;
}

export interface TokenCounts {
  /** Input tokens billed at the full input rate (excludes cache reads/writes). */
  input: number;
  cacheRead?: number;
  cacheWrite?: number;
  output: number;
}

/** Cost of one request against a price-table entry; 0 when the model is unknown. */
export function estimateCostUSD(info: ModelInfo | undefined, t: TokenCounts): number {
  if (!info) return 0;
  const cacheRead = t.cacheRead ?? 0;
  const cacheWrite = t.cacheWrite ?? 0;
  return (
    (t.input * info.inputUSDPerMTok +
      cacheRead * (info.cacheReadUSDPerMTok ?? info.inputUSDPerMTok) +
      cacheWrite * (info.cacheWriteUSDPerMTok ?? info.inputUSDPerMTok) +
      t.output * info.outputUSDPerMTok) /
    1_000_000
  );
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
