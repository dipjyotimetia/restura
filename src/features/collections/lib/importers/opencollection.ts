import { v4 as uuid } from 'uuid';
import {
  assertBoundedDocument,
  getAndResetUnrecognizedBodyCount,
  getAndResetUnrecognizedScripts,
  type OpenCollection,
  ocToInternal,
  ocVariableToKeyValue,
  openCollectionSchema,
} from '@/lib/opencollection';
import { formatZodIssues } from '@/lib/shared/validations';
import type { Collection, Environment } from '@/types';
import type { ImportResult, ImportWarning } from './types';

/**
 * @deprecated Maintained for callers using the legacy single-field result.
 * Prefer {@link importOpenCollection} which returns the unified ImportResult.
 */
export interface OpenCollectionImportResult {
  collection: Collection;
  unrecognizedBodies: number;
}

/**
 * Import an OpenCollection v1.0.0 document (already parsed from YAML or JSON)
 * and convert it into a Restura internal Collection.
 *
 * Accepts the bundled-file form (single document with all items inline).
 * Directory-layout import is provided through the Electron file picker via
 * `loadCollectionFromDir` — this entry point handles the in-memory case used
 * by the renderer's drop-zone uploader.
 */
export function importOpenCollection(data: unknown): ImportResult {
  // Guard depth before the recursive schema validates the tree (see schemas.ts).
  assertBoundedDocument(data);
  const result = openCollectionSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid OpenCollection document: ${formatZodIssues(result.error)}`);
  }
  const oc = result.data;
  const collection = ocToInternal(oc) as Collection;
  const environments = extractAdditionalEnvironments(oc, collection.id);
  applyPrivateVariables(collection, environments, oc);

  const warnings: ImportWarning[] = [];
  const bodyCount = getAndResetUnrecognizedBodyCount();
  if (bodyCount > 0) {
    warnings.push({ kind: 'unrecognized-body', requestName: `(${bodyCount} requests)` });
  }
  for (const s of getAndResetUnrecognizedScripts()) {
    warnings.push({
      kind: 'unrecognized-script-type',
      scriptType: s.type,
      requestName: s.requestName,
    });
  }

  return { collection, environments, warnings };
}

/**
 * Legacy detailed result. Returns just the `unrecognizedBodies` count that
 * early callers depended on. New code should use {@link importOpenCollection}.
 */
export function importOpenCollectionDetailed(data: unknown): OpenCollectionImportResult {
  const r = importOpenCollection(data);
  const unrecognizedBodies = r.warnings.filter((w) => w.kind === 'unrecognized-body').length;
  return { collection: r.collection, unrecognizedBodies };
}

/**
 * Extract environments beyond the first (the first env's variables are
 * already merged into Collection.variables for back-compat). Each becomes
 * a standalone Environment record the caller pushes to useEnvironmentStore.
 */
function extractAdditionalEnvironments(oc: OpenCollection, collectionId: string): Environment[] {
  const envs = oc.config?.environments ?? [];
  if (envs.length <= 1) return [];
  const ids = new Map<string, string>();
  for (const environment of envs.slice(1)) ids.set(environment.name, uuid());
  return envs.slice(1).map((e) => {
    const env = e as { name: string; variables?: Array<Record<string, unknown>>; extends?: string };
    return {
      id: ids.get(env.name)!,
      name: env.name,
      collectionId,
      ...(typeof env.extends === 'string' && ids.get(env.extends)
        ? { parentId: ids.get(env.extends) }
        : {}),
      // Shared mapper keeps every variable and preserves secret vars value-less
      // (a presence check like `'secret' in v` would wrongly drop `secret:false`).
      variables: (env.variables ?? []).map(ocVariableToKeyValue),
    };
  });
}

function applyPrivateVariables(
  collection: Collection,
  environments: Environment[],
  oc: OpenCollection
): void {
  const entries = (oc.extensions as Record<string, unknown> | undefined)?.[
    'x-restura-private-variables'
  ];
  if (!Array.isArray(entries)) return;
  const byName = new Map(environments.map((environment) => [environment.name, environment]));
  for (const entry of entries) {
    const value = entry as { environment?: unknown; names?: unknown };
    if (typeof value.environment !== 'string' || !Array.isArray(value.names)) continue;
    const target =
      value.environment === 'default'
        ? (collection.variables ?? (collection.variables = []))
        : byName.get(value.environment)?.variables;
    if (!target) continue;
    for (const name of value.names) {
      if (typeof name !== 'string' || target.some((variable) => variable.key === name)) continue;
      target.push({ id: uuid(), key: name, value: '', enabled: true, private: true });
    }
  }
}
