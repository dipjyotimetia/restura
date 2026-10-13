import type { GraphQLSchema as GQLSchema } from 'graphql';
import { useMemo } from 'react';
import { useGraphQLSchemaStore } from '@/store/useGraphQLSchemaStore';
import type { GraphQLImportedSchema } from '@/types';
import type { IntrospectionResult } from '../types';
import { buildSchemaFromIntrospection } from './introspection';
import { importedSchemaToResult } from './schemaImport';

export interface EffectiveGraphQLSchema {
  /** Introspection-shaped result for the explorer + autocomplete. */
  result: IntrospectionResult | null;
  /** Executable schema for validation / diagnostics / SDL export. */
  executable: GQLSchema | null;
  /** True when the schema came from the request's imported schema. */
  isImported: boolean;
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
  const importedResult = useMemo(
    () => (imported ? importedSchemaToResult(imported, url) : null),
    [imported, url]
  );
  const result = importedResult ?? introspected;
  const executable = useMemo(
    () => (result ? buildSchemaFromIntrospection(result) : null),
    [result]
  );
  return { result, executable, isImported: importedResult !== null };
}
