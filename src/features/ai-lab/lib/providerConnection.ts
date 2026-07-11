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
  storeSecret: SecretStorer;
  deleteSecret: SecretDeleter;
  discoverModels: (args: {
    provider: Provider;
    baseUrl: string;
    apiKeyHandleId?: string;
  }) => Promise<{ ok: true; models: DiscoveredModel[] } | { ok: false; error: string }>;
  addProvider: (input: ConnectedProviderInput) => string;
  now?: () => number;
}

type SecretDeleteResult = { ok: true } | { ok: false; error: string };
export type SecretStorer = (args: {
  value: string;
  label?: string;
  scope?: string;
}) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
export type SecretDeleter = (id: string) => Promise<SecretDeleteResult>;

async function storeSecretHandle(
  storeSecret: SecretStorer,
  args: Parameters<SecretStorer>[0]
): ReturnType<SecretStorer> {
  try {
    return await storeSecret(args);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function deleteSecretHandle(
  deleteSecret: SecretDeleter,
  id: string
): Promise<SecretDeleteResult> {
  try {
    return await deleteSecret(id);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function replaceSecretHandle(
  input: { value: string; label: string; oldHandleId?: string },
  deps: {
    storeSecret: SecretStorer;
    commitHandle: (handleId: string) => void;
    deleteSecret: SecretDeleter;
  }
): Promise<{ ok: true; handleId: string; cleanupWarning?: string } | { ok: false; error: string }> {
  const stored = await storeSecretHandle(deps.storeSecret, {
    scope: 'ai-lab',
    value: input.value,
    label: input.label,
  });
  if (!stored.ok) return stored;

  try {
    deps.commitHandle(stored.id);
  } catch (error) {
    const cleanup = await deleteSecretHandle(deps.deleteSecret, stored.id);
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: cleanup.ok ? message : `${message} Secret cleanup failed: ${cleanup.error}`,
    };
  }

  if (!input.oldHandleId) return { ok: true, handleId: stored.id };
  const cleanup = await deleteSecretHandle(deps.deleteSecret, input.oldHandleId);
  return cleanup.ok
    ? { ok: true, handleId: stored.id }
    : {
        ok: true,
        handleId: stored.id,
        cleanupWarning: `Could not remove the previous API key: ${cleanup.error}`,
      };
}

async function appendCleanupError(
  error: string,
  apiKeyHandleId: string | undefined,
  deleteSecret: SecretDeleter
): Promise<string> {
  if (!apiKeyHandleId) return error;
  const cleanup = await deleteSecretHandle(deleteSecret, apiKeyHandleId);
  return cleanup.ok ? error : `${error} Secret cleanup failed: ${cleanup.error}`;
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
    const stored = await storeSecretHandle(deps.storeSecret, {
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
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: await appendCleanupError(message, apiKeyHandleId, deps.deleteSecret),
    };
  }
  if (!discovered.ok) {
    return {
      ok: false,
      error: await appendCleanupError(discovered.error, apiKeyHandleId, deps.deleteSecret),
    };
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
