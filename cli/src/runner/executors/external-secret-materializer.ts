import { SECRET_FIELDS_BY_AUTH_BLOCK } from '@shared/secrets/auth-fields';
import type { ExternalSecretResolver } from '@shared/secrets/external-secret-resolver';
import type { AuthConfig } from '@shared/types';
import { CliRefusalError } from './failure';

type SecretCarrier = { [key: string]: unknown };

/** Every secret-bearing auth field, from the shared map every redactor uses. */
const SECRET_FIELDS = Object.entries(SECRET_FIELDS_BY_AUTH_BLOCK) as ReadonlyArray<
  [keyof typeof SECRET_FIELDS_BY_AUTH_BLOCK, readonly string[]]
>;

async function materializeValue(
  value: unknown,
  resolver: ExternalSecretResolver | undefined
): Promise<unknown> {
  if (!value || typeof value !== 'object' || (value as { kind?: unknown }).kind !== 'external') {
    return value;
  }
  if (!resolver) {
    throw new CliRefusalError(
      'Request uses an external secret reference. Configure an explicit external-secret profile for this CLI run.'
    );
  }
  return resolver.resolve(value as Parameters<ExternalSecretResolver['resolve']>[0]);
}

/** Resolve only external references; inline values and desktop handles retain their current CLI semantics. */
export async function materializeExternalSecretsInAuth(
  auth: AuthConfig | undefined,
  resolver: ExternalSecretResolver | undefined
): Promise<AuthConfig | undefined> {
  if (!auth) return auth;
  const next = { ...auth } as AuthConfig & Record<string, unknown>;
  for (const [block, fields] of SECRET_FIELDS) {
    const source = next[block] as SecretCarrier | undefined;
    if (!source || typeof source !== 'object') continue;
    const copy: SecretCarrier = { ...source };
    let changed = false;
    for (const field of fields) {
      if (!(field in copy)) continue;
      const value = await materializeValue(copy[field], resolver);
      if (value !== copy[field]) {
        copy[field] = value;
        changed = true;
      }
    }
    if (changed) (next as Record<string, unknown>)[block] = copy;
  }
  return next;
}
