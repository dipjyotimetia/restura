import { describe, expect, it } from 'vitest';
import type { HttpRequest } from '../types';
import { injectGraphQLBody, injectJsonStrings, injectJsonText } from './inject';

const vars: Record<string, string> = { name: 'O"Brien\\x', limit: '5', op: 'Find', id: '42' };
const inject = (text: string) => text.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);

describe('injectJsonStrings', () => {
  it('substitutes inside nested strings only, leaving keys and non-strings as written', () => {
    expect(
      injectJsonStrings(
        { '{{name}}': ['{{id}}', 1, null, true, { deep: '{{limit}}' }], n: 3 },
        inject
      )
    ).toEqual({ '{{name}}': ['42', 1, null, true, { deep: '5' }], n: 3 });
  });
});

describe('injectJsonText', () => {
  it('re-escapes a substituted value so the document stays valid JSON', () => {
    const out = injectJsonText('{"name":"{{name}}"}', inject);
    expect(JSON.parse(out)).toEqual({ name: 'O"Brien\\x' });
  });

  it('falls back to plain substitution for text that is not JSON yet', () => {
    expect(injectJsonText('{"limit": {{limit}}}', inject)).toBe('{"limit": 5}');
  });
});

describe('injectGraphQLBody', () => {
  const body = (fields: Partial<HttpRequest['body']>): HttpRequest['body'] => ({
    type: 'graphql',
    ...fields,
  });

  it('resolves an envelope’s query, operationName and variables, keeping other fields', () => {
    const raw = JSON.stringify({
      query: 'query {{op}} { user(id: "{{id}}") { name } }',
      operationName: '{{op}}',
      variables: { who: '{{name}}' },
      extensions: { persisted: '{{id}}' },
    });
    const out = injectGraphQLBody(body({ raw }), inject);
    expect(JSON.parse(out.raw ?? '')).toEqual({
      query: 'query Find { user(id: "42") { name } }',
      operationName: 'Find',
      variables: { who: 'O"Brien\\x' },
      extensions: { persisted: '{{id}}' },
    });
  });

  it('leaves non-string envelope fields untouched', () => {
    const raw = JSON.stringify({ query: 1, variables: null, operationName: 2 });
    expect(JSON.parse(injectGraphQLBody(body({ raw }), inject).raw ?? '')).toEqual({
      query: 1,
      variables: null,
      operationName: 2,
    });
  });

  it.each([
    ['a plain query document', 'query { user(id: {{id}}) }', 'query { user(id: 42) }'],
    ['a JSON array', '["{{id}}"]', '["42"]'],
    ['a JSON scalar', '"{{id}}"', '"42"'],
    ['JSON null', 'null', 'null'],
  ])('plain-substitutes %s', (_label, raw, expected) => {
    expect(injectGraphQLBody(body({ raw }), inject).raw).toBe(expected);
  });

  it('resolves separate variables JSON, and passes through a body with neither field', () => {
    const out = injectGraphQLBody(body({ graphqlVariables: '{"n":"{{name}}"}' }), inject);
    expect(out.raw).toBeUndefined();
    expect(JSON.parse(out.graphqlVariables ?? '')).toEqual({ n: 'O"Brien\\x' });
    const empty = body({});
    expect(injectGraphQLBody(empty, inject)).toBe(empty);
  });
});
