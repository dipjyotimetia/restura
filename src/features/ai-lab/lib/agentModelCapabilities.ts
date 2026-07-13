import type { ModelCapabilities } from '@shared/agent-lab';
import type { Usage } from '@shared/protocol/ai/types';
import type { AiLabProviderConfig } from '../types';

export const CONSERVATIVE_DESKTOP_CAPABILITIES: ModelCapabilities = {
  inputModalities: ['text'],
  outputModalities: ['text'],
  structuredOutput: false,
  toolCalling: false,
  parallelToolCalls: false,
  reasoning: false,
  continuation: false,
  serverTools: [],
};

export function capabilitiesForDesktopModel(
  config: AiLabProviderConfig,
  model: string
): { capabilities: ModelCapabilities; assertedByUser: boolean } {
  const override = config.capabilityOverrides?.[model];
  if (override) return { capabilities: override, assertedByUser: true };

  const discovered = config.modelDetails?.[model]?.agentCapabilities;
  return {
    capabilities: { ...CONSERVATIVE_DESKTOP_CAPABILITIES, ...discovered },
    assertedByUser: false,
  };
}

/**
 * Reports cost only when it can be derived from exact model metadata. Ollama
 * is the sole explicit local-zero classification; arbitrary compatible
 * gateways remain unknown even when their wire response estimates zero.
 */
export function knownCostForCompletion(
  config: AiLabProviderConfig,
  model: string,
  completion: Pick<Usage, 'promptTokens' | 'completionTokens'>
): number | undefined {
  if (config.provider === 'ollama' && config.isLocal) return 0;

  const pricing = config.modelDetails?.[model]?.pricing;
  const promptPrice = pricing?.promptPerMTokUSD;
  const completionPrice = pricing?.completionPerMTokUSD;
  if (
    promptPrice === undefined ||
    completionPrice === undefined ||
    !Number.isFinite(promptPrice) ||
    !Number.isFinite(completionPrice) ||
    promptPrice < 0 ||
    completionPrice < 0
  ) {
    return undefined;
  }

  return (
    (completion.promptTokens * promptPrice + completion.completionTokens * completionPrice) /
    1_000_000
  );
}
