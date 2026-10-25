import { resolveAuthFieldVariables } from '@shared/auth/resolve-variables';
import type { FormField } from '@shared/protocol/body-builder';
import { isProtocolExternalSecret } from '@shared/protocol/secret-value-schema';
import type {
  ProtocolAuthConfig,
  ProtocolSecretValue as SecretValue,
} from '@shared/protocol/types';
import { replaceSecretVariableTokenMatches } from '@shared/variables/secret-variable-token';
import { desktopExternalSecretResolver } from './external-secret-providers';
import { unwrapSecretValueMain } from './secret-handle-store';

export interface SecretVariableHttpConfig {
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  data?: string;
  formData?: FormField[];
  auth?: ProtocolAuthConfig;
  secretVariables?: Record<string, SecretValue>;
}

/** Resolve SecretRef-backed variables to plaintext (main process only). */
export async function resolveSecretVariableValues(
  secretVariables: Record<string, SecretValue>,
  signal?: AbortSignal
): Promise<Record<string, string>> {
  // Null prototype: a variable named `__proto__` / `constructor` is plain data.
  const values: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(secretVariables)) {
    const plaintext = isProtocolExternalSecret(value)
      ? await desktopExternalSecretResolver.resolve(value, { signal })
      : unwrapSecretValueMain(value);
    if (plaintext === undefined)
      throw new Error(`Secret variable "${name}" is unavailable on this desktop device`);
    values[name] = plaintext;
  }
  return values;
}

/** Replace `{{name}}` tokens with resolved secret-variable values; unknown tokens stay. */
export function replaceSecretVariableTokens(text: string, values: Record<string, string>): string {
  // Own-property lookup only: `{{constructor}}` / `{{toString}}` must not
  // resolve to inherited Object.prototype members.
  return replaceSecretVariableTokenMatches(
    text,
    (name) => Object.hasOwn(values, name),
    (name, token) => values[name] ?? token
  );
}

/** Materialize opaque SecretRef variables only in Electron main, before the wire request. */
export async function materializeSecretVariables<T extends SecretVariableHttpConfig>(
  config: T,
  signal?: AbortSignal
): Promise<T> {
  if (!config.secretVariables || Object.keys(config.secretVariables).length === 0) return config;
  const values = await resolveSecretVariableValues(config.secretVariables, signal);
  const replace = (text: string) => replaceSecretVariableTokens(text, values);
  return {
    ...config,
    url: replace(config.url),
    ...(config.headers
      ? {
          headers: Object.fromEntries(
            Object.entries(config.headers).map(([key, value]) => [key, replace(value)])
          ),
        }
      : {}),
    ...(config.params
      ? {
          params: Object.fromEntries(
            Object.entries(config.params).map(([key, value]) => [key, replace(value)])
          ),
        }
      : {}),
    ...(config.data !== undefined ? { data: replace(config.data) } : {}),
    ...(config.formData
      ? { formData: config.formData.map((field) => ({ ...field, value: replace(field.value) })) }
      : {}),
    // Auth descriptor value fields (sign-at-wire credentials, and Basic,
    // which the renderer defers here when it references a secret variable).
    // Same field map as the renderer/CLI resolver; header/param NAMES are
    // skipped so secret-derived names can't surface in header errors.
    ...(config.auth
      ? { auth: resolveAuthFieldVariables(config.auth, replace, { includeNames: false }) }
      : {}),
    secretVariables: undefined,
  };
}
