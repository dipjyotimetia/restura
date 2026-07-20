import { describe, expect, it } from 'vitest';
import { getGraphqlOperation } from '../graphql-operation';

describe('workflow GraphQL operation classification', () => {
  it('identifies the selected mutation from a saved request envelope', () => {
    expect(
      getGraphqlOperation({
        body: {
          type: 'graphql',
          raw: JSON.stringify({
            query: 'query Read { me { id } } mutation Update { update { id } }',
            operationName: 'Update',
          }),
        },
      })
    ).toEqual({ kind: 'mutation', name: 'Update' });
  });

  it('rejects subscriptions and ambiguous operation documents', () => {
    expect(() =>
      getGraphqlOperation({
        body: {
          type: 'graphql',
          raw: JSON.stringify({ query: 'subscription Watch { item { id } }' }),
        },
      })
    ).toThrow('subscriptions');
    expect(() =>
      getGraphqlOperation({
        body: {
          type: 'graphql',
          raw: JSON.stringify({ query: 'query One { a } query Two { b }' }),
        },
      })
    ).toThrow('operationName');
  });
});
