import { describe, expect, it } from 'vitest';
import { internalToOC } from './from-internal';
import { ocToInternal } from './to-internal';

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

describe('OpenCollection urlencoded round-trip', () => {
  it('exports the editor fields once and re-imports them unchanged', () => {
    const formData = [
      { id: 'a', key: 'name', value: 'Ada {{last}}', enabled: true, type: 'text' as const },
      { id: 'b', key: 'role', value: 'admin', enabled: false, type: 'text' as const },
    ];
    const exported = internalToOC({
      id: 'collection',
      name: 'Collection',
      items: [
        {
          id: 'item',
          name: 'Login',
          type: 'request',
          request: {
            id: 'request',
            name: 'Login',
            type: 'http',
            method: 'POST',
            url: 'https://example.test/login',
            headers: [],
            params: [],
            // The in-app editor keeps both shapes in sync.
            body: { type: 'x-www-form-urlencoded', formData, raw: 'name=Ada%20{{last}}' },
            auth: { type: 'none' },
          },
        },
      ],
      variables: [],
      auth: { type: 'none' },
    });

    const http = (exported.items?.[0] as { http: { body: unknown } }).http;
    expect(http.body).toEqual({ formUrlEncoded: { parts: formData } });

    const reimported = ocToInternal(exported).items[0]?.request;
    expect(reimported?.type === 'http' && reimported.body).toMatchObject({
      type: 'x-www-form-urlencoded',
      formData: formData.map(({ key, value, enabled }) => ({ key, value, enabled })),
    });
  });
});
