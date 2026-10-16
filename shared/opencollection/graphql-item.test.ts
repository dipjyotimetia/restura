import { describe, expect, it } from 'vitest';
import {
  graphqlDocumentFromInternal,
  graphqlMethodFromOC,
  graphqlMethodToOC,
} from './graphql-item';

describe('graphqlDocumentFromInternal', () => {
  it('returns a plain query document as-is, with stored variables', () => {
    expect(
      graphqlDocumentFromInternal({ type: 'graphql', raw: '{ me { id } }', graphqlVariables: '{}' })
    ).toEqual({ query: '{ me { id } }', variables: '{}' });
    expect(graphqlDocumentFromInternal({ type: 'graphql' })).toEqual({
      query: '',
      variables: undefined,
    });
  });

  it('unwraps a JSON envelope, taking string or object variables from it', () => {
    expect(
      graphqlDocumentFromInternal({
        type: 'graphql',
        raw: JSON.stringify({ query: 'query Q { a }', variables: { id: 1 } }),
      })
    ).toEqual({ query: 'query Q { a }', variables: '{"id":1}' });
    expect(
      graphqlDocumentFromInternal({
        type: 'graphql',
        raw: JSON.stringify({ query: 'query Q { a }', variables: '{"x":2}' }),
      })
    ).toEqual({ query: 'query Q { a }', variables: '{"x":2}' });
    expect(
      graphqlDocumentFromInternal({
        type: 'graphql',
        raw: JSON.stringify({ query: 'query Q { a }' }),
      })
    ).toEqual({ query: 'query Q { a }', variables: undefined });
  });

  it('lets stored graphqlVariables win over the envelope and ignores non-envelope JSON', () => {
    expect(
      graphqlDocumentFromInternal({
        type: 'graphql',
        raw: JSON.stringify({ query: 'q', variables: { a: 1 } }),
        graphqlVariables: '{"b":2}',
      })
    ).toEqual({ query: 'q', variables: '{"b":2}' });
    const raw = JSON.stringify({ notQuery: true });
    expect(graphqlDocumentFromInternal({ type: 'graphql', raw })).toEqual({
      query: raw,
      variables: undefined,
    });
  });
});

describe('graphql method mapping', () => {
  it('emits only GET and imports anything but GET as POST', () => {
    expect(graphqlMethodToOC('GET')).toEqual({ method: 'GET' });
    expect(graphqlMethodToOC('POST')).toEqual({});
    expect(graphqlMethodFromOC('get')).toBe('GET');
    expect(graphqlMethodFromOC('PUT')).toBe('POST');
    expect(graphqlMethodFromOC(undefined)).toBe('POST');
    expect(graphqlMethodFromOC(7)).toBe('POST');
  });
});
