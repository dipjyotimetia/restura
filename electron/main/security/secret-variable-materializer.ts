import type { FormField } from '@shared/protocol/body-builder';
import { isProtocolExternalSecret } from '@shared/protocol/secret-value-schema';
import type { ProtocolSecretValue as SecretValue } from '@shared/protocol/types';
import { desktopExternalSecretResolver } from './external-secret-providers';
import { unwrapSecretValueMain } from './secret-handle-store';

export interface SecretVariableHttpConfig {
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  data?: string;
  formData?: FormField[];
  secretVariables?: Record<string, SecretValue>;
}

/** Resolve SecretRef-backed variables to plaintext (main process only). */
export async function resolveSecretVariableValues(
  secretVariables: Record<string, SecretValue>,
  signal?: AbortSignal
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
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
  return text.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (match, name: string) => values[name] ?? match);
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
    secretVariables: undefined,
  };
}
