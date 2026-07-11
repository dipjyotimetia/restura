import type { DiscoveredModel } from '@shared/protocol/ai/model-discovery';
import type { Provider } from '@shared/protocol/ai/types';
import type { AiLabModelDetail, AiLabProviderConfig } from '../types';

export interface ProviderConnectionDraft {
  provider: Provider;
  label: string;
  baseUrl: string;
  /** Short-lived renderer form value; never passed to discovery IPC. */
  apiKey: string;
}

interface ConnectedProviderInput {
  provider: Provider;
  label: string;
  baseUrl?: string;
  apiKeyHandleId?: string;
  models: string[];
  modelDetails?: Record<string, AiLabModelDetail>;
  lastTest: NonNullable<AiLabProviderConfig['lastTest']>;
  lastDiscoveredAt: number;
}

interface ProviderConnectionDependencies {
  storeSecret: (args: {
    value: string;
    label?: string;
    scope?: string;
  }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  deleteSecret: (id: string) => Promise<unknown>;
  discoverModels: (args: {
    provider: Provider;
    baseUrl: string;
    apiKeyHandleId?: string;
  }) => Promise<{ ok: true; models: DiscoveredModel[] } | { ok: false; error: string }>;
  addProvider: (input: ConnectedProviderInput) => string;
  now?: () => number;
}

export function splitDiscoveredModels(models: DiscoveredModel[]): {
  models: string[];
  modelDetails: Record<string, AiLabModelDetail>;
} {
  const ids: string[] = [];
  const details: Record<string, AiLabModelDetail> = {};
  for (const model of models) {
    if (!model.id) continue;
    ids.push(model.id);
    const detail: AiLabModelDetail = {};
    if (model.label) detail.label = model.label;
    if (model.description) detail.description = model.description;
    if (model.contextLength) detail.contextLength = model.contextLength;
    if (model.modality) detail.modality = model.modality;
    if (model.pricing) detail.pricing = model.pricing;
    if (model.createdAt) detail.createdAt = model.createdAt;
    if (model.vendor) detail.vendor = model.vendor;
    if (model.family) detail.family = model.family;
    if (model.parameterSize) detail.parameterSize = model.parameterSize;
    if (model.quantizationLevel) detail.quantizationLevel = model.quantizationLevel;
    if (model.sizeBytes !== undefined) detail.sizeBytes = model.sizeBytes;
    if (model.modifiedAt) detail.modifiedAt = model.modifiedAt;
    if (Object.keys(detail).length > 0) details[model.id] = detail;
  }
  return { models: ids, modelDetails: details };
}

/**
 * Secure provider onboarding: create a keychain handle, discover through the
 * handle-only IPC contract, and persist only a ready provider. A failed probe
 * removes the temporary handle so retries never leak secrets.
 */
export async function connectAndAddProvider(
  draft: ProviderConnectionDraft,
  deps: ProviderConnectionDependencies
): Promise<{ ok: true; providerId: string; modelCount: number } | { ok: false; error: string }> {
  let apiKeyHandleId: string | undefined;
  if (draft.apiKey.trim()) {
    const stored = await deps.storeSecret({
      scope: 'ai-lab',
      value: draft.apiKey.trim(),
      label: `${draft.label.trim()} key`,
    });
    if (!stored.ok) return { ok: false, error: stored.error };
    apiKeyHandleId = stored.id;
  }

  let discovered: Awaited<ReturnType<ProviderConnectionDependencies['discoverModels']>>;
  try {
    discovered = await deps.discoverModels({
      provider: draft.provider,
      baseUrl: draft.baseUrl,
      ...(apiKeyHandleId ? { apiKeyHandleId } : {}),
    });
  } catch (error) {
    if (apiKeyHandleId) await deps.deleteSecret(apiKeyHandleId);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!discovered.ok) {
    if (apiKeyHandleId) await deps.deleteSecret(apiKeyHandleId);
    return { ok: false, error: discovered.error };
  }

  const at = (deps.now ?? Date.now)();
  const { models, modelDetails } = splitDiscoveredModels(discovered.models);
  const providerId = deps.addProvider({
    provider: draft.provider,
    label: draft.label.trim(),
    ...(draft.baseUrl ? { baseUrl: draft.baseUrl } : {}),
    ...(apiKeyHandleId ? { apiKeyHandleId } : {}),
    models,
    ...(Object.keys(modelDetails).length > 0 ? { modelDetails } : {}),
    lastTest: { ok: true, at, modelCount: models.length },
    lastDiscoveredAt: at,
  });
  return { ok: true, providerId, modelCount: models.length };
}
