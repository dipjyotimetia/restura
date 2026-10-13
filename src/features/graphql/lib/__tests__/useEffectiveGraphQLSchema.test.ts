import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useGraphQLSchemaStore } from '@/store/useGraphQLSchemaStore';
import type { GraphQLImportedSchema } from '@/types';
import type { IntrospectionResult } from '../../types';
import { importedSchemaToResult } from '../schemaImport';
import { useEffectiveGraphQLSchema } from '../useEffectiveGraphQLSchema';

const URL = 'https://api.example/graphql';

/** An introspection-cache entry, as the Refresh button would store it. */
function introspected(sdl: string): IntrospectionResult {
  return importedSchemaToResult({ sdl, source: 'introspection', importedAt: 1 }, URL);
}

const imported: GraphQLImportedSchema = {
  sdl: 'type Query { fromImport: Int }',
  source: 'sdl',
  importedAt: 1,
};

describe('useEffectiveGraphQLSchema', () => {
  beforeEach(() => {
    useGraphQLSchemaStore.setState({ schemas: {}, loading: {} });
  });

  it('returns nothing when there is no URL and no imported schema', () => {
    useGraphQLSchemaStore.setState({ schemas: { '': introspected('type Query { a: Int }') } });
    const { result } = renderHook(() => useEffectiveGraphQLSchema('', undefined));
    expect(result.current).toEqual({ result: null, executable: null });
  });

  it('falls back to the per-URL introspection cache', () => {
    useGraphQLSchemaStore.setState({
      schemas: { [URL]: introspected('type Query { cached: Int }') },
    });
    const { result } = renderHook(() => useEffectiveGraphQLSchema(URL, undefined));
    expect(result.current.result?.success).toBe(true);
    expect(result.current.executable?.getQueryType()?.getFields().cached).toBeDefined();
  });

  it('prefers the imported schema over the introspection cache', () => {
    useGraphQLSchemaStore.setState({
      schemas: { [URL]: introspected('type Query { cached: Int }') },
    });
    const { result } = renderHook(() => useEffectiveGraphQLSchema(URL, imported));
    const fields = result.current.executable?.getQueryType()?.getFields() ?? {};
    expect(fields.fromImport).toBeDefined();
    expect(fields.cached).toBeUndefined();
  });

  it('exposes the parse failure and no executable schema for a broken imported SDL', () => {
    const { result } = renderHook(() =>
      useEffectiveGraphQLSchema(URL, { ...imported, sdl: 'type Query {' })
    );
    expect(result.current.executable).toBeNull();
    expect(result.current.result?.success).toBe(false);
  });
});
