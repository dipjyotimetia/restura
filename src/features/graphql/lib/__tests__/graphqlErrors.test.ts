import { describe, expect, it } from 'vitest';
import {
  buildErrorMarkers,
  errorTreeHighlights,
  errorTreePath,
  formatErrorPath,
  locationToOffset,
  locationToRange,
  parseGraphQLErrors,
  parseGraphQLErrorsFromBody,
  resolveExistingPath,
  sentLocationToRange,
  sentQueryFromBody,
  subscriptionErrors,
  summarizeGraphQLErrors,
} from '../graphqlErrors';
import type { SubscriptionMessage } from '../subscriptionClient';

describe('parseGraphQLErrors', () => {
  it('normalises message, locations, path and extensions.code', () => {
    const errors = parseGraphQLErrors({
      data: null,
      errors: [
        {
          message: 'Cannot query field "nme"',
          locations: [{ line: 2, column: 5 }],
          path: ['user', 'friends', 1, 'name'],
          extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
        },
      ],
    });
    expect(errors).toEqual([
      {
        index: 0,
        message: 'Cannot query field "nme"',
        locations: [{ line: 2, column: 5 }],
        path: ['user', 'friends', 1, 'name'],
        code: 'GRAPHQL_VALIDATION_FAILED',
      },
    ]);
  });

  it('tolerates missing locations, path and non-string messages', () => {
    const errors = parseGraphQLErrors({ errors: [{}, { message: 42 }, 'nope', null] });
    expect(errors).toHaveLength(4);
    expect(errors[0]).toEqual({
      index: 0,
      message: 'Unknown GraphQL error',
      locations: [],
      path: null,
    });
    expect(errors[1]?.message).toBe('Unknown GraphQL error');
    expect(errors[2]?.message).toBe('nope');
    expect(errors[3]?.index).toBe(3);
  });

  it('drops malformed locations and path segments but keeps valid ones', () => {
    const [error] = parseGraphQLErrors({
      errors: [
        {
          message: 'x',
          locations: [{ line: 0, column: 1 }, { line: 'a' }, { line: 3, column: 7 }, null],
          path: ['a', { bad: true }, 2],
          extensions: { code: 7 },
        },
      ],
    });
    expect(error?.locations).toEqual([{ line: 3, column: 7 }]);
    expect(error?.path).toBeNull();
    expect(error?.code).toBeUndefined();
  });

  it('accepts numeric path segments (list indices)', () => {
    const [error] = parseGraphQLErrors({ errors: [{ message: 'x', path: ['partial', 1] }] });
    expect(error?.path).toEqual(['partial', 1]);
  });

  it('returns [] for payloads without an errors array', () => {
    expect(parseGraphQLErrors(null)).toEqual([]);
    expect(parseGraphQLErrors({ data: {} })).toEqual([]);
    expect(parseGraphQLErrors({ errors: 'x' })).toEqual([]);
    expect(parseGraphQLErrors([1, 2])).toEqual([]);
  });

  it('caps the number of errors it keeps', () => {
    const errors = parseGraphQLErrors({
      errors: Array.from({ length: 1000 }, (_, i) => ({ message: `e${i}` })),
    });
    expect(errors.length).toBe(200);
  });
});

describe('parseGraphQLErrorsFromBody', () => {
  it('parses a JSON body', () => {
    expect(parseGraphQLErrorsFromBody('{"errors":[{"message":"a"}]}')).toHaveLength(1);
  });
  it('returns [] for non-JSON or empty bodies', () => {
    expect(parseGraphQLErrorsFromBody('')).toEqual([]);
    expect(parseGraphQLErrorsFromBody('<html>')).toEqual([]);
  });
});

describe('locationToOffset', () => {
  const source = 'query {\n  user {\n    nme\n  }\n}';

  it('converts a 1-based line/column to a 0-based offset', () => {
    expect(locationToOffset(source, { line: 1, column: 1 })).toBe(0);
    expect(locationToOffset(source, { line: 3, column: 5 })).toBe(source.indexOf('nme'));
  });

  it('treats \\r\\n and lone \\r as single line breaks (graphql-js semantics)', () => {
    const crlf = 'query {\r\n  a\r  b\n}';
    expect(locationToOffset(crlf, { line: 2, column: 3 })).toBe(crlf.indexOf('a'));
    expect(locationToOffset(crlf, { line: 3, column: 3 })).toBe(crlf.indexOf('b'));
  });

  it('clamps out-of-range lines and columns into the document', () => {
    expect(locationToOffset(source, { line: 99, column: 1 })).toBe(source.lastIndexOf('\n') + 1);
    expect(locationToOffset(source, { line: 1, column: 500 })).toBe(source.indexOf('\n'));
  });
});

describe('locationToRange', () => {
  it('spans the name token at the location', () => {
    const source = 'query {\n  user {\n    nme\n  }\n}';
    expect(locationToRange(source, { line: 3, column: 5 })).toEqual({
      startLineNumber: 3,
      startColumn: 5,
      endLineNumber: 3,
      endColumn: 8,
    });
  });

  it('spans a single character for punctuation', () => {
    expect(locationToRange('{ }', { line: 1, column: 1 })).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 2,
    });
  });

  it('includes the $ / @ sigil of variables and directives', () => {
    const range = locationToRange('query ($id: ID) { a @skip }', { line: 1, column: 8 });
    expect(range.endColumn - range.startColumn).toBe(3);
    const directive = locationToRange('query { a @skip }', { line: 1, column: 11 });
    expect(directive.endColumn - directive.startColumn).toBe(5);
  });

  it('clamps a location past the end of the document onto its last line', () => {
    const range = locationToRange('{\n  a\n}', { line: 10, column: 1 });
    expect(range.startLineNumber).toBe(3);
    expect(range.startColumn).toBe(1);
  });

  it('handles an empty document', () => {
    expect(locationToRange('', { line: 1, column: 1 })).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    });
  });
});

describe('buildErrorMarkers', () => {
  it('emits one marker per location with the code in the message', () => {
    const source = 'query {\n  a\n  b\n}';
    const errors = parseGraphQLErrors({
      errors: [
        {
          message: 'bad',
          locations: [
            { line: 2, column: 3 },
            { line: 3, column: 3 },
          ],
          extensions: { code: 'E1' },
        },
        { message: 'no location' },
      ],
    });
    const markers = buildErrorMarkers(source, errors);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({
      severity: 8,
      message: '[E1] bad',
      source: 'GraphQL response',
      startLineNumber: 2,
      startColumn: 3,
      endColumn: 4,
    });
    expect(markers[1]?.startLineNumber).toBe(3);
  });
});

describe('sentLocationToRange (variable-substituted queries)', () => {
  it('maps 1:1 when the sent text equals the editor text', () => {
    const q = '{\n  a\n}';
    expect(sentLocationToRange(q, q, { line: 2, column: 3 })).toEqual(
      locationToRange(q, { line: 2, column: 3 })
    );
  });

  it('shifts columns after a placeholder whose value has a different length', () => {
    const raw = '{ user(id: "{{userId}}") { nme } }';
    const sent = '{ user(id: "1") { nme } }';
    // `nme` is at column 19 in the sent text, column 26 in the editor.
    expect(sentLocationToRange(raw, sent, { line: 1, column: 19 })).toEqual({
      startLineNumber: 1,
      startColumn: raw.indexOf('nme') + 1,
      endLineNumber: 1,
      endColumn: raw.indexOf('nme') + 4,
    });
  });

  it('maps a location inside a substituted value onto the whole placeholder', () => {
    const raw = 'query {\n  {{field}} { id }\n}';
    const sent = 'query {\n  usr { id }\n}';
    expect(sentLocationToRange(raw, sent, { line: 2, column: 3 })).toEqual({
      startLineNumber: 2,
      startColumn: 3,
      endLineNumber: 2,
      endColumn: 3 + '{{field}}'.length,
    });
  });

  it('keeps later lines aligned when a value spans several lines', () => {
    const raw = '{\n  {{frag}}\n  bad\n}';
    const sent = '{\n  a\n  b\n  bad\n}';
    expect(sentLocationToRange(raw, sent, { line: 4, column: 3 })).toEqual({
      startLineNumber: 3,
      startColumn: 3,
      endLineNumber: 3,
      endColumn: 6,
    });
  });

  it('treats adjacent placeholders as one region', () => {
    const raw = '{ {{a}}{{b}} }';
    const sent = '{ xy }';
    expect(sentLocationToRange(raw, sent, { line: 1, column: 4 })).toEqual({
      startLineNumber: 1,
      startColumn: 3,
      endLineNumber: 1,
      endColumn: 3 + '{{a}}{{b}}'.length,
    });
  });

  it('rejects ambiguous alignments where a value contains the next literal', () => {
    // `a` between the placeholders could be any of the three sent `a`s.
    expect(sentLocationToRange('{ {{x}}a{{y}} }', '{ aaa }', { line: 1, column: 3 })).toBeNull();
    expect(
      buildErrorMarkers(
        '{ {{x}}a{{y}} }',
        parseGraphQLErrors({ errors: [{ message: 'm', locations: [{ line: 1, column: 3 }] }] }),
        '{ aaa }'
      )
    ).toEqual([]);
  });

  it('still maps when a repeated literal has only one feasible position', () => {
    // The value `b` can't contain `, ` so the middle literal is pinned.
    const raw = 'f(a: {{x}}, b: {{y}}) { nme }';
    const sent = 'f(a: 1, b: 2) { nme }';
    const range = sentLocationToRange(raw, sent, { line: 1, column: sent.indexOf('nme') + 1 });
    expect(range?.startColumn).toBe(raw.indexOf('nme') + 1);
  });

  it('handles a query that starts or ends with a placeholder', () => {
    const raw = '{{op}} { nme }';
    const sent = 'query Q { nme }';
    expect(sentLocationToRange(raw, sent, { line: 1, column: 11 })?.startColumn).toBe(
      raw.indexOf('nme') + 1
    );
    expect(sentLocationToRange('{ a }{{tail}}', '{ a }\n', { line: 1, column: 3 })).toEqual(
      locationToRange('{ a }', { line: 1, column: 3 })
    );
  });

  it('returns null when the sent text cannot be aligned with the editor text', () => {
    expect(sentLocationToRange('{ a }', '{ b }', { line: 1, column: 3 })).toBeNull();
    expect(sentLocationToRange('{ {{x}} }', 'query { 1 }', { line: 1, column: 3 })).toBeNull();
  });

  it('buildErrorMarkers maps through the sent text and drops unmappable locations', () => {
    const raw = '{ user(id: "{{userId}}") { nme } }';
    const errors = parseGraphQLErrors({
      errors: [{ message: 'bad', locations: [{ line: 1, column: 19 }] }],
    });
    const [marker] = buildErrorMarkers(raw, errors, '{ user(id: "1") { nme } }');
    expect(marker?.startColumn).toBe(raw.indexOf('nme') + 1);
    expect(buildErrorMarkers(raw, errors, 'totally different')).toEqual([]);
  });
});

describe('formatErrorPath / errorTreePath', () => {
  it('renders object keys with dots and numeric segments as indices', () => {
    expect(formatErrorPath(['user', 'friends', 1, 'name'])).toBe('user.friends[1].name');
    expect(formatErrorPath([0, 'a'])).toBe('[0].a');
    expect(formatErrorPath(null)).toBe('');
  });

  it('roots a response path under data', () => {
    expect(errorTreePath(['user', 0])).toEqual(['data', 'user', 0]);
  });
});

describe('resolveExistingPath', () => {
  const body = { data: { partial: [{ id: '1' }, null], user: null } };

  it('returns the full path when every segment exists', () => {
    expect(resolveExistingPath(body, ['data', 'partial', 0, 'id'])).toEqual([
      'data',
      'partial',
      0,
      'id',
    ]);
  });

  it('keeps a nulled leaf (null-bubbled errors still point at it)', () => {
    expect(resolveExistingPath(body, ['data', 'partial', 1])).toEqual(['data', 'partial', 1]);
  });

  it('falls back to the deepest existing ancestor', () => {
    expect(resolveExistingPath(body, ['data', 'user', 'name'])).toEqual(['data', 'user']);
    expect(resolveExistingPath(body, ['data', 'partial', 9, 'id'])).toEqual(['data', 'partial']);
    expect(resolveExistingPath({}, ['data', 'x'])).toEqual([]);
  });

  it('does not treat string keys as array indices', () => {
    expect(resolveExistingPath(body, ['data', 'partial', '0'])).toEqual(['data', 'partial']);
  });
});

describe('subscriptionErrors', () => {
  it('collects errors from data (next) payloads, newest message last', () => {
    const messages: SubscriptionMessage[] = [
      { id: 'm1', type: 'connected', timestamp: 1 },
      { id: 'm2', type: 'data', timestamp: 2, payload: { data: { tick: 1 } } },
      {
        id: 'm3',
        type: 'data',
        timestamp: 3,
        payload: { data: null, errors: [{ message: 'tick failed', path: ['tick'] }] },
      },
    ];
    const errors = subscriptionErrors(messages);
    expect(errors).toEqual([
      {
        messageId: 'm3',
        payload: { data: null, errors: [{ message: 'tick failed', path: ['tick'] }] },
        error: { index: 0, message: 'tick failed', locations: [], path: ['tick'] },
      },
    ]);
  });
});

describe('errorTreeHighlights', () => {
  it('maps each error path to the deepest rendered node under data', () => {
    const body = { data: { partial: [{ id: '1' }, null] } };
    const errors = parseGraphQLErrors({
      errors: [
        { message: 'user 9 not found', path: ['partial', 1], extensions: { code: 'NOT_FOUND' } },
        { message: 'gone', path: ['partial', 1, 'name'] },
        { message: 'request-level' },
      ],
    });
    expect(errorTreeHighlights(body, errors)).toEqual([
      { path: ['data', 'partial', 1], label: '[NOT_FOUND] user 9 not found' },
      { path: ['data', 'partial', 1], label: 'gone' },
    ]);
  });

  it('falls back to data itself, and skips when data is absent', () => {
    const errors = parseGraphQLErrors({ errors: [{ message: 'x', path: ['a'] }] });
    expect(errorTreeHighlights({ data: null }, errors)).toEqual([{ path: ['data'], label: 'x' }]);
    expect(errorTreeHighlights({}, errors)).toEqual([]);
  });
});

describe('sentQueryFromBody', () => {
  it('extracts the query from a sent GraphQL JSON envelope', () => {
    expect(sentQueryFromBody('{"query":"{ a }","variables":{}}')).toBe('{ a }');
  });
  it('returns undefined for missing, non-JSON or query-less bodies', () => {
    expect(sentQueryFromBody(undefined)).toBeUndefined();
    expect(sentQueryFromBody('nope')).toBeUndefined();
    expect(sentQueryFromBody('{"variables":{}}')).toBeUndefined();
  });
});

describe('summarizeGraphQLErrors', () => {
  it('pluralises', () => {
    expect(summarizeGraphQLErrors(1)).toBe('GraphQL returned 1 error');
    expect(summarizeGraphQLErrors(3)).toBe('GraphQL returned 3 errors');
  });
});
