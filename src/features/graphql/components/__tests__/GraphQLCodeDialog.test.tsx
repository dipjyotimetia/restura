import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest } from '@/types';

const captured = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@/components/shared/ProtocolCodeDialog', () => ({
  ProtocolCodeDialog: (props: Record<string, unknown>) => {
    captured.push(props);
    return null;
  },
}));

import { GraphQLCodeDialog } from '../GraphQLCodeDialog';

const request: HttpRequest = {
  id: 'r',
  name: 'r',
  type: 'http',
  method: 'POST',
  url: 'https://api.test/graphql',
  headers: [
    { id: 'a', key: 'Authorization', value: 'Bearer {{t}}', enabled: true },
    { id: 'b', key: 'X-Off', value: '1', enabled: false },
    { id: 'c', key: '', value: 'orphan', enabled: true },
  ],
  params: [],
  body: { type: 'graphql' },
  auth: { type: 'none' },
};

function optionsFor(variables: string, operationType?: 'mutation' | null) {
  render(
    <GraphQLCodeDialog
      open
      onOpenChange={vi.fn()}
      request={request}
      query="{ me { id } }"
      variables={variables}
      operationType={operationType}
    />
  );
  return captured[captured.length - 1]?.options as Record<string, unknown>;
}

afterEach(() => {
  captured.length = 0;
});

describe('GraphQLCodeDialog', () => {
  it('passes url, query, parsed variables, enabled headers and operation type', () => {
    const options = optionsFor('{"id":1}', 'mutation');
    expect(options).toEqual({
      url: 'https://api.test/graphql',
      query: '{ me { id } }',
      variables: { id: 1 },
      headers: { Authorization: 'Bearer {{t}}' },
      operationType: 'mutation',
    });
    expect(captured[0]?.title).toBe('Generate GraphQL code');
  });

  it.each([
    ['empty text', ''],
    ['invalid JSON', '{oops'],
    ['an array', '[1,2]'],
    ['a primitive', '42'],
    ['null', 'null'],
  ])('falls back to {} variables for %s and omits a null operation type', (_label, text) => {
    const options = optionsFor(text, null);
    expect(options.variables).toEqual({});
    expect(options).not.toHaveProperty('operationType');
  });
});
