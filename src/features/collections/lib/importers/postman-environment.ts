import { v4 as uuid } from 'uuid';
import type { Environment, KeyValue } from '@/types';
import type { ImportWarning } from './types';

/**
 * The shape of a Postman exported environment file (`*.postman_environment.json`).
 * These files are distinct from collection exports — they only carry env vars.
 */
interface PostmanEnvFile {
  id?: string;
  name: string;
  values: Array<{ key: string; value: string; enabled?: boolean; type?: string }>;
  _postman_variable_scope?: 'environment' | 'globals';
  _postman_exported_at?: string;
  _postman_exported_using?: string;
}

/**
 * Returns true when `data` looks like a Postman environment file.
 * The discriminator is `_postman_variable_scope === 'environment'`. The
 * `globals` scope is intentionally excluded for now — it has different
 * semantics in Postman that we don't surface in Restura.
 */
export function isPostmanEnvironment(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return d._postman_variable_scope === 'environment' && Array.isArray(d.values);
}

/** Options shared by the environment-file importers (Postman, Hoppscotch). */
export interface EnvironmentImportOptions {
  /**
   * Keep the plaintext value of secret-typed variables. Defaults to `false`
   * (the safe behaviour): secret values are dropped and one re-enter warning
   * is emitted per key. The caller decides per platform: desktop keeps them
   * the way a hand-typed secret env var is kept, web drops them (#1231).
   */
  keepSecretValues?: boolean;
}

export interface EnvironmentImportResult {
  environment: Environment;
  /** One `secret-variable` warning per dropped secret. Never carries a value. */
  warnings: ImportWarning[];
  /** Keys of secret variables whose value was dropped (empty when kept). */
  droppedSecretKeys: string[];
}

const SECRET_DROPPED_DETAIL = 'Secret variable imported without a value; re-enter it';

/**
 * Apply the secret-value policy to freshly mapped env vars. Shared by the
 * Postman and Hoppscotch environment importers so the two cannot drift.
 */
export function applyEnvironmentSecretPolicy(
  environment: Environment,
  options: EnvironmentImportOptions = {}
): EnvironmentImportResult {
  if (options.keepSecretValues === true) {
    return { environment, warnings: [], droppedSecretKeys: [] };
  }
  const warnings: ImportWarning[] = [];
  const droppedSecretKeys: string[] = [];
  const variables = environment.variables.map((v): KeyValue => {
    if (!v.secret) return v;
    droppedSecretKeys.push(v.key);
    warnings.push({
      kind: 'unmodelled-construct',
      construct: 'secret-variable',
      requestName: environment.name,
      detail: `${SECRET_DROPPED_DETAIL}: ${v.key}`,
    });
    return { ...v, value: '' };
  });
  return { environment: { ...environment, variables }, warnings, droppedSecretKeys };
}

/**
 * Convert a parsed Postman environment file into a Restura Environment.
 * Variables marked `type === 'secret'` are flagged with `secret: true` so
 * the UI can mask them; their values are dropped unless
 * `options.keepSecretValues` is set. `enabled` defaults to true when absent
 * (Postman's default behavior).
 */
export function importPostmanEnvironmentDetailed(
  data: unknown,
  options: EnvironmentImportOptions = {}
): EnvironmentImportResult {
  if (!isPostmanEnvironment(data)) {
    throw new Error(
      'Not a Postman environment file (missing _postman_variable_scope = "environment")'
    );
  }
  const env = data as PostmanEnvFile;
  return applyEnvironmentSecretPolicy(
    {
      id: uuid(),
      name: env.name,
      variables: env.values.map(
        (v): KeyValue => ({
          id: uuid(),
          key: v.key,
          value: v.value ?? '',
          enabled: v.enabled !== false,
          ...(v.type === 'secret' ? { secret: true } : {}),
        })
      ),
    },
    options
  );
}

/** {@link importPostmanEnvironmentDetailed} without the warnings. */
export function importPostmanEnvironment(
  data: unknown,
  options: EnvironmentImportOptions = {}
): Environment {
  return importPostmanEnvironmentDetailed(data, options).environment;
}
