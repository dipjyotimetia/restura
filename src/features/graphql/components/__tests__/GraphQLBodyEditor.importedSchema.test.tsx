import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/shared/CodeEditor', () => ({ default: () => null }));

import { useGraphQLSchemaStore } from '@/store/useGraphQLSchemaStore';
import GraphQLBodyEditor from '../GraphQLBodyEditor';

const imported = {
  sdl: 'type Query {\n  viewer: Account\n}\n\ntype Account {\n  id: ID!\n}',
  source: 'sdl' as const,
  importedAt: 1,
};

describe('GraphQLBodyEditor with an imported schema', () => {
  beforeEach(() => {
    useGraphQLSchemaStore.setState({ schemas: {}, loading: {} });
  });

  it('validates the query against the imported schema', () => {
    render(
      <GraphQLBodyEditor
        query="{ viewer { email } }"
        variables="{}"
        url="https://no-introspection.example/graphql"
        importedSchema={imported}
        onQueryChange={() => {}}
        onVariablesChange={() => {}}
      />
    );
    expect(screen.getByText(/Cannot query field "email" on type "Account"/)).toBeTruthy();
  });

  it('reports no errors for a query the imported schema accepts', () => {
    render(
      <GraphQLBodyEditor
        query="{ viewer { id } }"
        variables="{}"
        url="https://no-introspection.example/graphql"
        importedSchema={imported}
        onQueryChange={() => {}}
        onVariablesChange={() => {}}
      />
    );
    expect(screen.queryByText(/Cannot query field/)).toBeNull();
  });
});
