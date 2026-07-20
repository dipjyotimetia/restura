import { describe, expect, it } from 'vitest';
import { internalToOC } from './from-internal';

describe('OpenCollection GraphQL export', () => {
  it('keeps a workflow-selectable GraphQL request as a native GraphQL item', () => {
    const collection = internalToOC({
      id: 'collection',
      name: 'Collection',
      items: [
        {
          id: 'item',
          name: 'Find user',
          type: 'request',
          request: {
            id: 'request',
            name: 'Find user',
            type: 'http',
            method: 'POST',
            url: 'https://example.test/graphql',
            headers: [],
            params: [],
            body: { type: 'graphql', raw: 'query Find { me { id } }' },
            auth: { type: 'none' },
          },
        },
      ],
      variables: [],
      auth: { type: 'none' },
    });

    expect(collection.items?.[0]).toMatchObject({
      info: { type: 'graphql', name: 'Find user' },
      graphql: { query: 'query Find { me { id } }' },
    });
  });

  it('preserves the separate GraphQL variables document', () => {
    const collection = internalToOC({
      id: 'collection',
      name: 'Collection',
      items: [
        {
          id: 'item',
          name: 'Find user',
          type: 'request',
          request: {
            id: 'request',
            name: 'Find user',
            type: 'http',
            method: 'POST',
            url: 'https://example.test/graphql',
            headers: [],
            params: [],
            body: {
              type: 'graphql',
              raw: 'query Find($id: ID!) { user(id: $id) { id } }',
              graphqlVariables: '{"id":"user-1"}',
            },
            auth: { type: 'none' },
          },
        },
      ],
      variables: [],
      auth: { type: 'none' },
    });

    expect(collection.items?.[0]).toMatchObject({
      graphql: {
        query: 'query Find($id: ID!) { user(id: $id) { id } }',
        variables: '{"id":"user-1"}',
      },
    });
  });
});
