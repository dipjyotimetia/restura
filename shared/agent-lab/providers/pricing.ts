import { anthropicModule } from '../../protocol/ai/providers/anthropic';
import { openaiModule } from '../../protocol/ai/providers/openai';
import { estimateCostUSD, type ModelInfo } from '../../protocol/ai/providers/types';

/** USD per million tokens. Same shape as the shared assistant price tables. */
export type AgentModelPrice = Pick<
  ModelInfo,
  'inputUSDPerMTok' | 'outputUSDPerMTok' | 'cacheReadUSDPerMTok' | 'cacheWriteUSDPerMTok'
>;

/** Operator-supplied prices keyed by model id (CLI runtime manifest). */
export type AgentModelPriceOverrides = Readonly<Record<string, AgentModelPrice>>;

export interface AgentTokenCounts {
  /** Input tokens billed at the full input rate (excludes cache reads/writes). */
  input: number;
  cacheRead?: number;
  cacheWrite?: number;
  output: number;
}

const TABLES: Record<string, readonly ModelInfo[]> = {
  'openai.responses': openaiModule.models,
  'anthropic.messages': anthropicModule.models,
};

/** Price for an exact model id: manifest override first, then the shared provider table. */
export function resolveModelPrice(
  providerId: string,
  model: string,
  overrides?: AgentModelPriceOverrides
): AgentModelPrice | undefined {
  const override = overrides && Object.hasOwn(overrides, model) ? overrides[model] : undefined;
  return override ?? TABLES[providerId]?.find((candidate) => candidate.id === model);
}

/**
 * Exact cost of one call, or undefined when it cannot be derived: an unpriced
 * model, or cached tokens with no cached rate (billing them at the input rate
 * would be a guess, so cost stays unknown rather than mispriced).
 */
export function knownCostUSD(
  price: AgentModelPrice | undefined,
  tokens: AgentTokenCounts
): number | undefined {
  if (!price) return undefined;
  if ((tokens.cacheRead ?? 0) > 0 && price.cacheReadUSDPerMTok === undefined) return undefined;
  if ((tokens.cacheWrite ?? 0) > 0 && price.cacheWriteUSDPerMTok === undefined) return undefined;
  return estimateCostUSD({ id: '', label: '', contextWindow: 0, ...price }, tokens);
}
