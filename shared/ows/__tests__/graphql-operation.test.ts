import { describe, expect, it } from 'vitest';
import { getGraphqlOperation, getGraphqlResponseErrors } from '../graphql-operation';

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

  it('accepts renderer query text and unnamed single operations', () => {
    expect(
      getGraphqlOperation({ body: { type: 'graphql', raw: 'query { viewer { id } }' } })
    ).toEqual({ kind: 'query' });
    expect(
      getGraphqlOperation({
        body: { type: 'graphql', raw: JSON.stringify({ query: 'mutation Save { save { id } }' }) },
      })
    ).toEqual({ kind: 'mutation', name: 'Save' });
  });

  it.each([
    ['a non-GraphQL body', { body: { type: 'json', raw: '{}' } }],
    ['a missing request body', {}],
    ['a non-string GraphQL body', { body: { type: 'graphql', raw: {} } }],
    ['an empty saved query', { body: { type: 'graphql', raw: JSON.stringify({ query: '  ' }) } }],
    [
      'an unknown selected operation',
      {
        body: {
          type: 'graphql',
          raw: JSON.stringify({ query: 'query One { one }', operationName: 'Two' }),
        },
      },
    ],
  ])('rejects %s', (_name, request) => {
    expect(() => getGraphqlOperation(request)).toThrow();
  });

  it('extracts response error messages without trusting malformed response values', () => {
    expect(
      getGraphqlResponseErrors(
        JSON.stringify({ errors: [{ message: 'first' }, {}, 'not-an-error'] })
      )
    ).toEqual(['first', 'Unknown GraphQL error', 'Unknown GraphQL error']);
    expect(getGraphqlResponseErrors('{')).toEqual([]);
    expect(getGraphqlResponseErrors(JSON.stringify({ errors: {} }))).toEqual([]);
    expect(getGraphqlResponseErrors({ errors: [{ message: 'not read' }] })).toEqual([]);
  });
});
