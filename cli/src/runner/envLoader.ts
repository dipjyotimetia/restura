import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import * as yaml from 'js-yaml';

export interface EnvLoadOptions {
  /** When true, `${VAR}` placeholders in values resolve from `process.env`. */
  expandEnvVars?: boolean;
}

/**
 * Load environment variables from a JSON or YAML file.
 *
 * Two shapes are accepted:
 *   - a flat object of `{ key: value }` pairs (non-string values are skipped);
 *   - a Postman environment or globals export (`*.postman_environment.json`,
 *     `*.postman_globals.json`: `{ values: [{ key, value, enabled }] }`), so a
 *     Newman `-e` / `-g` file works unchanged. Disabled rows are skipped and
 *     scalar values are stringified; a `secret` row's value is used as-is.
 *
 * When `expandEnvVars` is set, `${VAR}` references in values are resolved from
 * `process.env`, so secrets can come from CI env vars instead of being
 * committed to the env file.
 */
export async function loadEnv(
  filePath: string,
  options: EnvLoadOptions = {}
): Promise<Record<string, string>> {
  const text = await readFile(filePath, 'utf-8');
  const ext = extname(filePath).toLowerCase();
  let parsed: unknown;
  if (ext === '.yaml' || ext === '.yml') {
    parsed = yaml.load(text);
  } else {
    parsed = JSON.parse(text);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Env file must be an object of key→value pairs (got ${
        Array.isArray(parsed) ? 'array' : typeof parsed
      })`
    );
  }
  const entries = isPostmanVariableExport(parsed)
    ? postmanEntries(parsed.values)
    : Object.entries(parsed as Record<string, unknown>);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (typeof v !== 'string') continue;
    out[k] = options.expandEnvVars ? expandEnvVars(v) : v;
  }
  return out;
}

/**
 * A Postman environment / globals export. `values` must be an array, and the
 * export carries `_postman_variable_scope` (or at least an `id` / `name`
 * beside `values`), so a flat env that merely has a `values` key is not
 * mistaken for one.
 */
function isPostmanVariableExport(v: object): v is { values: unknown[] } {
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.values)) return false;
  if (o._postman_variable_scope === 'environment' || o._postman_variable_scope === 'globals') {
    return true;
  }
  return typeof o.name === 'string' || typeof o.id === 'string';
}

function postmanEntries(values: unknown[]): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const row of values) {
    if (!row || typeof row !== 'object') continue;
    const { key, value, enabled } = row as { key?: unknown; value?: unknown; enabled?: unknown };
    if (typeof key !== 'string' || key === '' || enabled === false) continue;
    if (typeof value === 'string') out.push([key, value]);
    else if (typeof value === 'number' || typeof value === 'boolean') {
      out.push([key, String(value)]);
    } else if (value === undefined || value === null) out.push([key, '']);
  }
  return out;
}

function expandEnvVars(value: string): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_match, name: string) => {
    return process.env[name] ?? '';
  });
}
