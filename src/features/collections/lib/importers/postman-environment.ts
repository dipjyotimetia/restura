import { v4 as uuid } from 'uuid';
import type { Environment, KeyValue } from '@/types';

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

/**
 * Convert a parsed Postman environment file into a Restura Environment.
 * Variables marked `type === 'secret'` are flagged with `secret: true` so
 * the UI can mask them. `enabled` defaults to true when absent (Postman's
 * default behavior).
 */
export function importPostmanEnvironment(data: unknown): Environment {
  if (!isPostmanEnvironment(data)) {
    throw new Error('Not a Postman environment file (missing _postman_variable_scope = "environment")');
  }
  const env = data as PostmanEnvFile;
  return {
    id: uuid(),
    name: env.name,
    variables: env.values.map((v): KeyValue => ({
      id: uuid(),
      key: v.key,
      value: v.value ?? '',
      enabled: v.enabled !== false,
      ...(v.type === 'secret' ? { secret: true } : {}),
    })),
  };
}
