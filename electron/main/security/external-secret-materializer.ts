import { isProtocolExternalSecret } from '@shared/protocol/secret-value-schema';
import type { ProtocolAuthConfig, ProtocolSecretValue } from '@shared/protocol/types';
import { desktopExternalSecretResolver } from './external-secret-providers';

const FIELDS: Array<[string, string[]]> = [
  ['basic', ['password']],
  ['bearer', ['token']],
  ['apiKey', ['value']],
  ['oauth2', ['accessToken', 'refreshToken', 'clientSecret']],
  ['awsSignature', ['secretKey']],
  ['oauth1', ['consumerSecret', 'accessToken', 'accessTokenSecret']],
  ['ntlm', ['password']],
  ['wsse', ['password']],
];

/** Resolve only external values in trusted main, preserving existing handle resolution. */
export async function materializeExternalProtocolAuth(
  auth: ProtocolAuthConfig | undefined,
  signal?: AbortSignal
): Promise<ProtocolAuthConfig | undefined> {
  if (!auth) return auth;
  const next = { ...auth } as ProtocolAuthConfig & Record<string, unknown>;
  for (const [block, fields] of FIELDS) {
    const source = next[block] as Record<string, ProtocolSecretValue | undefined> | undefined;
    if (!source) continue;
    const copy = { ...source };
    let changed = false;
    for (const field of fields) {
      const value = copy[field];
      if (isProtocolExternalSecret(value)) {
        copy[field] = await desktopExternalSecretResolver.resolve(value, { signal });
        changed = true;
      }
    }
    if (changed) (next as Record<string, unknown>)[block] = copy;
  }
  return next;
}
