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
});
