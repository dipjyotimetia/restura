import type { ProtocolSecretRef } from '@shared/protocol/types';

export type ExternalSecretReference = Extract<ProtocolSecretRef, { kind: 'external' }>;
export type ExternalSecretProviderName = ExternalSecretReference['provider'];

export interface ExternalSecretProvider {
  provider: ExternalSecretProviderName;
  resolve(reference: ExternalSecretReference, options?: { signal?: AbortSignal }): Promise<string>;
}

export type ExternalSecretErrorCode =
  | 'provider-unavailable'
  | 'profile-unavailable'
  | 'not-found'
  | 'access-denied'
  | 'cancelled'
  | 'provider-error';

/** A stable, renderer-safe provider error. Never retain a provider's raw text. */
export class ExternalSecretError extends Error {
  constructor(
    public readonly code: ExternalSecretErrorCode,
    public readonly provider: ExternalSecretProviderName,
    public readonly label?: string
  ) {
    super(`${providerDisplayName(provider)} ${messageFor(code, label)}.`);
    this.name = 'ExternalSecretError';
  }
}

export interface ExternalSecretResolver {
  resolve(reference: ExternalSecretReference, options?: { signal?: AbortSignal }): Promise<string>;
}

const PROVIDER_DISPLAY_NAMES: Record<ExternalSecretProviderName, string> = {
  'aws-secrets-manager': 'AWS Secrets Manager',
  'google-secret-manager': 'Google Secret Manager',
  'azure-key-vault': 'Azure Key Vault',
};

function providerDisplayName(provider: ExternalSecretProviderName): string {
  return PROVIDER_DISPLAY_NAMES[provider];
}

function messageFor(code: ExternalSecretErrorCode, label: string | undefined): string {
  const reference = label ? `could not resolve ${label}` : 'could not resolve the selected secret';
  switch (code) {
    case 'provider-unavailable':
      return ' is not configured for this runtime';
    case 'profile-unavailable':
      return ' profile is unavailable';
    case 'not-found':
      return `${reference} because it was not found`;
    case 'access-denied':
      return `${reference} because access was denied`;
    case 'cancelled':
      return ' resolution was cancelled';
    case 'provider-error':
      return reference;
  }
}

function asExternalSecretError(
  error: unknown,
  reference: ExternalSecretReference
): ExternalSecretError {
  if (error instanceof ExternalSecretError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ExternalSecretError('cancelled', reference.provider, reference.label);
  }
  return new ExternalSecretError('provider-error', reference.provider, reference.label);
}

/**
 * Create a fail-closed resolver. Providers only receive references matching
 * their own name, and raw provider errors never leave the trusted runtime.
 */
export function createExternalSecretResolver(
  providers: readonly ExternalSecretProvider[]
): ExternalSecretResolver {
  const byName = new Map<ExternalSecretProviderName, ExternalSecretProvider>();
  for (const provider of providers) byName.set(provider.provider, provider);

  return {
    async resolve(reference, options) {
      if (options?.signal?.aborted) {
        throw new ExternalSecretError('cancelled', reference.provider, reference.label);
      }
      const provider = byName.get(reference.provider);
      if (!provider) {
        throw new ExternalSecretError('provider-unavailable', reference.provider, reference.label);
      }
      try {
        const value = await provider.resolve(reference, options);
        if (!value) throw new ExternalSecretError('not-found', reference.provider, reference.label);
        return value;
      } catch (error) {
        throw asExternalSecretError(error, reference);
      }
    },
  };
}
