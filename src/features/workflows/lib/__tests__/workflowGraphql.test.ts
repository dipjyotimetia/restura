import { describe, expect, it } from 'vitest';
import { findWorkflowGraphqlMutations } from '../workflowGraphql';

describe('workflow GraphQL preflight', () => {
  it('finds saved mutation calls before execution', () => {
    expect(
      findWorkflowGraphqlMutations(
        {
          document: { dsl: '1.0.3', namespace: 'restura', name: 'gql', version: '1.0.0' },
          do: [
            {
              update: {
                call: 'http',
                with: { method: 'POST', endpoint: { uri: 'restura://saved-request' } },
              },
            },
          ],
        } as never,
        {
          version: 1,
          tasks: {
            '/do/0/update': {
              kind: 'saved-request',
              call: 'http',
              protocol: 'graphql',
              resourceId: 'Update',
            },
          },
        },
        [
          {
            id: 'item',
            name: 'Update',
            type: 'request',
            request: {
              id: 'request',
              name: 'Update',
              type: 'http',
              method: 'POST',
              url: 'https://example.test/graphql',
              headers: [],
              params: [],
              body: {
                type: 'graphql',
                raw: JSON.stringify({ query: 'mutation Update { update { id } }' }),
              },
              auth: { type: 'none' },
            },
          },
        ]
      )
    ).toEqual([{ taskPath: '/do/0/update', name: 'Update' }]);
  });

  it('walks nested do, try, and catch call paths while ignoring queries and unbound calls', () => {
    const request = {
      id: 'request',
      name: 'Mutation',
      type: 'http' as const,
      method: 'POST' as const,
      url: 'https://example.test/graphql',
      headers: [],
      params: [],
      body: {
        type: 'graphql' as const,
        raw: JSON.stringify({ query: 'mutation Mutation { save { id } }' }),
      },
      auth: { type: 'none' as const },
    };
    const items = [
      {
        id: 'folder',
        name: 'Folder',
        type: 'folder' as const,
        items: [
          { id: 'mutation', name: 'Mutation', type: 'request' as const, request },
          {
            id: 'query',
            name: 'Query',
            type: 'request' as const,
            request: {
              ...request,
              id: 'query-request',
              body: {
                type: 'graphql' as const,
                raw: JSON.stringify({ query: 'query Query { viewer { id } }' }),
              },
            },
          },
        ],
      },
    ];
    const workflow = {
      document: { dsl: '1.0.3', namespace: 'restura', name: 'nested', version: '1.0.0' },
      do: [
        { group: { do: [{ mutation: { call: 'http' } }, { skipped: { call: 'http' } }] } },
        {
          recover: {
            try: [{ query: { call: 'http' } }],
            catch: { do: [{ fallback: { call: 'http' } }] },
          },
        },
      ],
    } as never;

    expect(
      findWorkflowGraphqlMutations(
        workflow,
        {
          version: 1,
          tasks: {
            '/do/0/group/do/0/mutation': {
              kind: 'saved-request',
              call: 'http',
              protocol: 'graphql',
              resourceId: 'Folder/Mutation',
            },
            '/do/1/recover/try/0/query': {
              kind: 'saved-request',
              call: 'http',
              protocol: 'graphql',
              resourceId: 'Folder/Query',
            },
            '/do/1/recover/catch/do/0/fallback': {
              kind: 'saved-request',
              call: 'http',
              protocol: 'graphql',
              resourceId: 'Folder/Missing',
            },
          },
        },
        items
      )
    ).toEqual([{ taskPath: '/do/0/group/do/0/mutation', name: 'Mutation' }]);
  });

  it('identifies an invalid saved GraphQL resource before execution', () => {
    expect(() =>
      findWorkflowGraphqlMutations(
        {
          document: { dsl: '1.0.3', namespace: 'restura', name: 'invalid', version: '1.0.0' },
          do: [{ call: { call: 'http' } }],
        } as never,
        {
          version: 1,
          tasks: {
            '/do/0/call': {
              kind: 'saved-request',
              call: 'http',
              protocol: 'graphql',
              resourceId: 'Broken',
            },
          },
        },
        [
          {
            id: 'broken',
            name: 'Broken',
            type: 'request',
            request: {
              id: 'broken-request',
              name: 'Broken',
              type: 'http',
              method: 'POST',
              url: 'https://example.test/graphql',
              headers: [],
              params: [],
              body: { type: 'graphql', raw: JSON.stringify({ query: '' }) },
              auth: { type: 'none' },
            },
          },
        ]
      )
    ).toThrow('Workflow GraphQL binding Broken is invalid');
  });
});
