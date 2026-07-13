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
const MAX_SERVER_TOOLS = 32;
const MAX_SERVER_TOOL_LENGTH = 64;
const MAX_TOKEN_LIMIT = 100_000_000;

function normalizedModalities(value: unknown, fallback: readonly Modality[]): Modality[] {
  if (!Array.isArray(value) || value.length === 0) return [...fallback];
  if (value.some((candidate) => !ALLOWED_MODALITIES.has(candidate as Modality))) {
    return [...fallback];
  }
  const normalized = [...new Set(value as Modality[])];
  return normalized.length > 0 ? normalized : [...fallback];
}

function normalizedServerTools(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SERVER_TOOLS) return [];
  if (
    value.some(
      (candidate) =>
        typeof candidate !== 'string' ||
        candidate.trim().length === 0 ||
        candidate.length > MAX_SERVER_TOOL_LENGTH
    )
  )
    return [];
  return [...new Set(value)];
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
  return {
    inputModalities: normalizedModalities(
      value?.inputModalities,
      CONSERVATIVE_DESKTOP_CAPABILITIES.inputModalities
    ),
    outputModalities: normalizedModalities(
      value?.outputModalities,
      CONSERVATIVE_DESKTOP_CAPABILITIES.outputModalities
    ),
    structuredOutput: value?.structuredOutput === true,
    toolCalling,
    parallelToolCalls: toolCalling && value?.parallelToolCalls === true,
    reasoning: value?.reasoning === true,
    continuation: value?.continuation === true,
    serverTools: toolCalling ? normalizedServerTools(value?.serverTools) : [],
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
    detail && hasTrustedCapabilityProvenance(detail) ? detail.agentCapabilities : undefined;
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
