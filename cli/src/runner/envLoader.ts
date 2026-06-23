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
 * Format: a flat object of `{ key: value }` pairs. Non-string values are
 * skipped. The format is intentionally simpler than Postman's environment
 * export — for v0.1 we accept the simple shape and add Postman-export support
 * later if users ask for it.
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
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    out[k] = options.expandEnvVars ? expandEnvVars(v) : v;
  }
  return out;
}

function expandEnvVars(value: string): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_match, name: string) => {
    return process.env[name] ?? '';
  });
}
