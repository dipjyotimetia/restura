import type { Environment } from '@/types';

/**
 * Surface a "host"-like variable so chrome / sidebar / env-manager rows can
 * hint at what an environment points at (api.example.com etc.).
 *
 * Consolidates three near-identical implementations that previously lived in
 * `TopBar.envHostHint`, `EnvSwitcher.describeEnv`, and `EnvironmentManager.hostHint`.
 * The variable-name list is the union of what each call site recognised, so
 * existing collections don't regress when their host hint gets routed through
 * here.
 */
const HOST_KEYS = new Set([
  'host',
  'baseurl',
  'base_url',
  'apihost',
  'api_host',
  'url',
  'api_url',
  'apiurl',
]);

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/-/g, '_');
}

/**
 * Return the host portion of the env's "host-like" variable, or `null` if
 * none is present. Strips protocol, falls back to the raw value if URL
 * parsing fails (e.g. `{{api}}.example.com` template strings).
 */
export function envHostHint(env: Environment | null | undefined): string | null {
  if (!env) return null;
  const match = env.variables.find((v) => v.enabled && HOST_KEYS.has(normaliseKey(v.key)));
  if (!match || !match.value) return null;
  try {
    return new URL(match.value).host;
  } catch {
    return match.value.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  }
}

/**
 * Like `envHostHint`, but with a graceful fallback to "<n> variable(s)" when
 * no host-like variable exists. Used by switchers / dropdowns that need
 * *some* subtitle in every row.
 */
export function describeEnv(env: Environment): string {
  const host = envHostHint(env);
  if (host) return host;
  const n = env.variables.length;
  return `${n} variable${n === 1 ? '' : 's'}`;
}
