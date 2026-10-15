import { describe, expect, it } from 'vitest';
import {
  buildGraphQLRequestBody,
  graphQLOperationAtOffset,
  listGraphQLOperations,
  selectGraphQLOperation,
} from './operations';

const names = (query: string) => listGraphQLOperations(query).operations.map((o) => o.name);
const types = (query: string) => listGraphQLOperations(query).operations.map((o) => o.type);

describe('listGraphQLOperations — AST path', () => {
  it('lists every operation with its name and type', () => {
    const doc = 'query A { a } mutation B { b } subscription C { c }';
    const parsed = listGraphQLOperations(doc);
    expect(parsed.parsed).toBe(true);
    expect(parsed.operations.map((o) => [o.name, o.type])).toEqual([
      ['A', 'query'],
      ['B', 'mutation'],
      ['C', 'subscription'],
    ]);
  });

  it('treats a shorthand document as an anonymous query', () => {
    expect(listGraphQLOperations('{ user { id } }').operations).toMatchObject([
      { name: null, type: 'query' },
    ]);
  });

  it('classifies a comment-first subscription (GQL-1)', () => {
    expect(types('# live feed\nsubscription OnEvent { eventAdded { id } }')).toEqual([
      'subscription',
    ]);
  });

  it('classifies a fragment-first subscription (GQL-1)', () => {
    const doc = 'fragment F on Event { id }\nsubscription OnEvent { eventAdded { ...F } }';
    expect(listGraphQLOperations(doc).operations).toMatchObject([
      { name: 'OnEvent', type: 'subscription' },
    ]);
  });

  it('never takes a name from comments or strings (GQL-2)', () => {
    const doc = '# query Fake\n{ search(term: "mutation Nope") { id } }';
    expect(names(doc)).toEqual([null]);
    expect(types(doc)).toEqual(['query']);
  });

  it('extracts variable definitions per operation', () => {
    const doc =
      'query A($id: ID!, $tags: [String!] = ["x"]) { a } mutation B($input: In!) { b(input: $input) }';
    const [a, b] = listGraphQLOperations(doc).operations;
    expect(a?.variables).toEqual([
      { name: 'id', type: 'ID!', isRequired: true },
      { name: 'tags', type: '[String!]', isRequired: false, defaultValue: '["x"]' },
    ]);
    expect(b?.variables).toEqual([{ name: 'input', type: 'In!', isRequired: true }]);
  });

  it('records source offsets for each operation', () => {
    const doc = 'query A { a }\nquery B { b }';
    const [a, b] = listGraphQLOperations(doc).operations;
    expect(doc.slice(a?.start, a?.end)).toBe('query A { a }');
    expect(doc.slice(b?.start, b?.end)).toBe('query B { b }');
  });

  it('returns no operations for an empty or fragment-only document', () => {
    expect(listGraphQLOperations('').operations).toEqual([]);
    expect(listGraphQLOperations('   ').operations).toEqual([]);
    expect(listGraphQLOperations('fragment F on T { id }').operations).toEqual([]);
  });
});

describe('listGraphQLOperations — fallback scan on parse errors', () => {
  it('still detects a subscription that is mid-edit', () => {
    const parsed = listGraphQLOperations('# c\nsubscription OnEvent { eventAdded { ');
    expect(parsed.parsed).toBe(false);
    expect(parsed.error).toBeTruthy();
    expect(parsed.operations).toMatchObject([{ name: 'OnEvent', type: 'subscription' }]);
  });

  it('skips fragments, comments and strings while scanning', () => {
    const doc =
      'fragment F on T { id }\n# mutation Fake\nquery Real($a: In = {x: "subscription S"}) { a(x: "query Q") { ...F } }\nmutation Next { b';
    const parsed = listGraphQLOperations(doc);
    expect(parsed.parsed).toBe(false);
    expect(parsed.operations.map((o) => [o.name, o.type])).toEqual([
      ['Real', 'query'],
      ['Next', 'mutation'],
    ]);
  });

  it('detects shorthand and anonymous keyword operations', () => {
    expect(listGraphQLOperations('{ a ').operations).toMatchObject([{ name: null, type: 'query' }]);
    expect(listGraphQLOperations('mutation { a(').operations).toMatchObject([
      { name: null, type: 'mutation' },
    ]);
  });

  it('closes each scanned operation at its matching brace', () => {
    const doc = 'query A { a { b } }\nquery B { c';
    const [a, b] = listGraphQLOperations(doc).operations;
    expect(doc.slice(a?.start, a?.end)).toBe('query A { a { b } }');
    expect(b?.end).toBe(doc.length);
  });

  it('keeps what it found before a lexer error', () => {
    const parsed = listGraphQLOperations('subscription S { a }\nquery Q { "unterminated');
    expect(parsed.parsed).toBe(false);
    expect(parsed.operations[0]).toMatchObject({ name: 'S', type: 'subscription' });
  });
});

describe('selectGraphQLOperation', () => {
  const ops = listGraphQLOperations('query A { a } subscription B { b }').operations;

  it('returns the named operation when it exists', () => {
    expect(selectGraphQLOperation(ops, 'B')?.type).toBe('subscription');
  });

  it('falls back to the first operation for a missing/stale/empty name', () => {
    expect(selectGraphQLOperation(ops, 'Gone')?.name).toBe('A');
    expect(selectGraphQLOperation(ops, undefined)?.name).toBe('A');
    expect(selectGraphQLOperation(ops, null)?.name).toBe('A');
  });

  it('returns undefined when there are no operations', () => {
    expect(selectGraphQLOperation([], 'A')).toBeUndefined();
  });
});

describe('graphQLOperationAtOffset', () => {
  const doc = 'query A { a }\n\nquery B { b }';
  const ops = listGraphQLOperations(doc).operations;

  it('finds the operation containing the offset', () => {
    expect(graphQLOperationAtOffset(ops, doc.indexOf('a }'))?.name).toBe('A');
    expect(graphQLOperationAtOffset(ops, doc.indexOf('b }'))?.name).toBe('B');
  });

  it('treats the end of an operation as inside it', () => {
    expect(graphQLOperationAtOffset(ops, doc.indexOf('}') + 1)?.name).toBe('A');
  });

  it('returns undefined between operations', () => {
    expect(graphQLOperationAtOffset(ops, doc.indexOf('\n\n') + 1)).toBeUndefined();
  });
});

describe('buildGraphQLRequestBody', () => {
  it('sends the selected operation name', () => {
    const doc = 'query First { a } query Second { b }';
    expect(buildGraphQLRequestBody(doc, {}, 'Second')).toEqual({
      query: doc,
      variables: {},
      operationName: 'Second',
    });
  });

  it('defaults to the first operation when nothing (or a stale name) is selected', () => {
    const doc = 'query First { a } query Second { b }';
    expect(buildGraphQLRequestBody(doc, {}).operationName).toBe('First');
    expect(buildGraphQLRequestBody(doc, {}, 'Renamed').operationName).toBe('First');
  });

  it('omits operationName for anonymous operations', () => {
    const body = buildGraphQLRequestBody('{ user { id } }', { a: 1 });
    expect(body).toEqual({ query: '{ user { id } }', variables: { a: 1 } });
  });

  it('never derives a name from comments', () => {
    const body = buildGraphQLRequestBody('# query Fake\n{ a }', {});
    expect('operationName' in body).toBe(false);
  });
});
