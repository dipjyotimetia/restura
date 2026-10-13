import type { GraphQLSchema as GQLSchema } from 'graphql';
import { useMemo } from 'react';
import { useGraphQLSchemaStore } from '@/store/useGraphQLSchemaStore';
import type { GraphQLImportedSchema } from '@/types';
import type { IntrospectionResult } from '../types';
import { buildSchemaFromIntrospection } from './introspection';
import { importedSchemaToResult, loadImportedSchema } from './schemaImport';

export interface EffectiveGraphQLSchema {
  /** Introspection-shaped result for the explorer + autocomplete. */
  result: IntrospectionResult | null;
  /** Executable schema for validation / diagnostics / SDL export. */
  executable: GQLSchema | null;
}

/**
 * The schema a GraphQL request should be edited against: the request's
 * imported schema when present, otherwise the per-URL introspection cache.
 */
export function useEffectiveGraphQLSchema(
  url: string,
  imported: GraphQLImportedSchema | undefined
): EffectiveGraphQLSchema {
  const introspected = useGraphQLSchemaStore((s) => (url ? (s.schemas[url] ?? null) : null));
  const importedSchema = useMemo(() => {
    if (!imported) return null;
    // Shared, SDL-keyed: the builder and body editor reuse one built schema.
    const loaded = loadImportedSchema(imported.sdl);
    return {
      result: importedSchemaToResult(imported, url),
      executable: loaded.ok ? loaded.executable : null,
    };
  }, [imported, url]);
  const introspectedExecutable = useMemo(
    () => (!importedSchema && introspected ? buildSchemaFromIntrospection(introspected) : null),
    [importedSchema, introspected]
  );
  return importedSchema ?? { result: introspected, executable: introspectedExecutable };
}
