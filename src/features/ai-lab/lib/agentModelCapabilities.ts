import type { Modality, ModelCapabilities } from '@shared/agent-lab';
import type { Usage } from '@shared/protocol/ai/types';
import type { AiLabModelDetail, AiLabProviderConfig } from '../types';

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

const ALLOWED_MODALITIES = new Set<Modality>(['text', 'image', 'audio', 'document']);
const MAX_TOKEN_LIMIT = 100_000_000;

function normalizedModalities(value: unknown, fallback: readonly Modality[]): Modality[] {
  if (!Array.isArray(value) || value.length === 0) return [...fallback];
  if (value.some((candidate) => !ALLOWED_MODALITIES.has(candidate as Modality))) {
    return [...fallback];
  }
  const normalized = [...new Set(value as Modality[])];
  return normalized.length > 0 ? normalized : [...fallback];
}

export function normalizeDesktopCapabilities(
  value:
    | {
        inputModalities?: unknown;
        outputModalities?: unknown;
        structuredOutput?: unknown;
        toolCalling?: unknown;
        parallelToolCalls?: unknown;
        reasoning?: unknown;
        continuation?: unknown;
        serverTools?: unknown;
        maxContextTokens?: unknown;
        maxOutputTokens?: unknown;
      }
    | undefined
): ModelCapabilities {
  const toolCalling = value?.toolCalling === true;
  const maxContextTokens = value?.maxContextTokens;
  const maxOutputTokens = value?.maxOutputTokens;
  const advertisedInput = normalizedModalities(
    value?.inputModalities,
    CONSERVATIVE_DESKTOP_CAPABILITIES.inputModalities
  );
  const advertisedOutput = normalizedModalities(
    value?.outputModalities,
    CONSERVATIVE_DESKTOP_CAPABILITIES.outputModalities
  );
  return {
    inputModalities: advertisedInput.filter((modality) => modality === 'text'),
    outputModalities: advertisedOutput.filter((modality) => modality === 'text'),
    structuredOutput: false,
    toolCalling,
    parallelToolCalls: toolCalling && value?.parallelToolCalls === true,
    reasoning: false,
    continuation: false,
    serverTools: [],
    ...(typeof maxContextTokens === 'number' &&
    Number.isInteger(maxContextTokens) &&
    maxContextTokens > 0 &&
    maxContextTokens <= MAX_TOKEN_LIMIT
      ? { maxContextTokens }
      : {}),
    ...(typeof maxOutputTokens === 'number' &&
    Number.isInteger(maxOutputTokens) &&
    maxOutputTokens > 0 &&
    maxOutputTokens <= MAX_TOKEN_LIMIT
      ? { maxOutputTokens }
      : {}),
  };
}

export function hasTrustedCapabilityProvenance(detail: AiLabModelDetail): boolean {
  const provenance = detail?.agentCapabilityProvenance;
  return (
    provenance?.source === 'discovered' &&
    provenance.adapterId === 'openrouter.models' &&
    provenance.adapterVersion === 1
  );
}

export function capabilitiesForDesktopModel(
  config: AiLabProviderConfig,
  model: string
): { capabilities: ModelCapabilities; assertedByUser: boolean } {
  if (!config.models.includes(model)) {
    return { capabilities: CONSERVATIVE_DESKTOP_CAPABILITIES, assertedByUser: false };
  }
  const override = config.capabilityOverrides?.[model];
  if (override) {
    return { capabilities: normalizeDesktopCapabilities(override), assertedByUser: true };
  }

  const detail = config.modelDetails?.[model];
  const discovered =
    config.provider === 'openrouter' && detail && hasTrustedCapabilityProvenance(detail)
      ? detail.agentCapabilities
      : undefined;
  return {
    capabilities: normalizeDesktopCapabilities(discovered),
    assertedByUser: false,
  };
}

/**
 * Reports cost only when it can be derived from exact model metadata or an
 * explicit user assertion that the configured endpoint is local and free.
 */
export function knownCostForCompletion(
  config: AiLabProviderConfig,
  model: string,
  completion: Pick<Usage, 'promptTokens' | 'completionTokens'>
): number | undefined {
  if (!config.models.includes(model)) return undefined;
  if (config.costPolicy === 'local-zero') return 0;

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
