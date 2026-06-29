import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';
import * as yaml from 'js-yaml';
import { isRecord, ROOT_FILENAMES } from '../util/oc';

/**
 * Walk up from a request file to the directory containing the OpenCollection
 * root file. Returns undefined if none is found before the filesystem root.
 */
export function findCollectionRoot(filePath: string): string | undefined {
  let dir = dirname(filePath);
  const { root } = parsePath(dir);
  // Bounded by the filesystem root.
  for (;;) {
    if (ROOT_FILENAMES.some((f) => existsSync(join(dir, f)))) return dir;
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
}

/**
 * Load variables from the collection's default environment (the one named
 * `default`, else the first). Only plain string values are returned — secret
 * variables (which carry no value on disk) are skipped. Best-effort: returns
 * `{}` on any read/parse failure.
 *
 * MVP limitation: there is no environment picker; only the default env is used.
 */
export function loadDefaultEnvVars(collectionDir: string): Record<string, string> {
  for (const f of ROOT_FILENAMES) {
    const p = join(collectionDir, f);
    if (!existsSync(p)) continue;
    try {
      const doc = yaml.load(readFileSync(p, 'utf8'), { schema: yaml.JSON_SCHEMA });
      if (!isRecord(doc) || !isRecord(doc.config)) return {};
      const envs = doc.config.environments;
      if (!Array.isArray(envs) || envs.length === 0) return {};
      const chosen =
        (envs as unknown[]).find((e) => isRecord(e) && e.name === 'default') ?? envs[0];
      if (!isRecord(chosen) || !Array.isArray(chosen.variables)) return {};

      const out: Record<string, string> = {};
      for (const variable of chosen.variables as unknown[]) {
        if (!isRecord(variable)) continue;
        if (variable.secret === true) continue; // no value on disk
        if (variable.disabled === true) continue;
        if (typeof variable.name !== 'string') continue;
        const val = variable.value;
        if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
          out[variable.name] = String(val);
        }
      }
      return out;
    } catch {
      return {};
    }
  }
  return {};
}
