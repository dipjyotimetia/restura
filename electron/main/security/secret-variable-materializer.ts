import type { FormField } from '@shared/protocol/body-builder';
import type { ProtocolSecretValue as SecretValue } from '@shared/protocol/types';
import { unwrapSecretValueMain } from './secret-handle-store';

export interface SecretVariableHttpConfig {
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  data?: string;
  formData?: FormField[];
  secretVariables?: Record<string, SecretValue>;
}

/** Materialize opaque SecretRef variables only in Electron main, before the wire request. */
export function materializeSecretVariables<T extends SecretVariableHttpConfig>(config: T): T {
  if (!config.secretVariables || Object.keys(config.secretVariables).length === 0) return config;
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(config.secretVariables)) {
    const plaintext = unwrapSecretValueMain(value);
    if (plaintext === undefined)
      throw new Error(`Secret variable "${name}" is unavailable on this desktop device`);
    values[name] = plaintext;
  }
  const replace = (text: string) =>
    text.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (match, name: string) => values[name] ?? match);
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
