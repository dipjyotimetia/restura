import { describe, expect, it } from 'vitest';
import {
  fieldViolationsOf,
  inputDescriptorFor,
  locateFieldViolations,
  parseFieldPath,
  resolveViolationPath,
} from '../grpcFieldViolations';

const PROTO = `
syntax = "proto3";
package lib.v1;
service Library { rpc CreateBook(CreateBookRequest) returns (Book); }
message CreateBookRequest { string parent = 1; Book book = 2; }
message Book {
  string display_name = 1;
  repeated Author authors = 2;
  repeated string tags = 3;
}
message Author { string given_name = 1; string email_address = 2; }
`;
const input = inputDescriptorFor(
  { kind: 'proto', fileName: 'lib.proto', text: PROTO },
  'lib.v1.Library',
  'CreateBook'
);

function textAt(text: string, range: { start: number; end: number } | null): string | null {
  return range ? text.slice(range.start, range.end) : null;
}

describe('fieldViolationsOf', () => {
  it('flattens every BadRequest detail and ignores other types', () => {
    expect(
      fieldViolationsOf([
        { type: 'google.rpc.ErrorInfo', value: { reason: 'X' } },
        {
          type: 'google.rpc.BadRequest',
          value: {
            fieldViolations: [{ field: 'a', description: 'A', reason: 'R' }, { field: 'b' }],
          },
        },
        { type: 'google.rpc.BadRequest', raw: 'AA==' },
      ])
    ).toEqual([
      { field: 'a', description: 'A', reason: 'R' },
      { field: 'b', description: '' },
    ]);
    expect(fieldViolationsOf(undefined)).toEqual([]);
  });
});

describe('parseFieldPath', () => {
  it('splits dotted, bracketed, quoted and numeric-dotted paths', () => {
    expect(parseFieldPath('book.authors[1].given_name')).toEqual([
      'book',
      'authors',
      1,
      'given_name',
    ]);
    expect(parseFieldPath('labels["k.x"]')).toEqual(['labels', 'k.x']);
    expect(parseFieldPath("labels['env']")).toEqual(['labels', 'env']);
    expect(parseFieldPath('labels[env]')).toEqual(['labels', 'env']);
    expect(parseFieldPath('items.2.name')).toEqual(['items', 2, 'name']);
    expect(parseFieldPath('')).toEqual([]);
  });
});

describe('inputDescriptorFor', () => {
  it('resolves the method input message from a proto snapshot', () => {
    expect(input?.typeName).toBe('lib.v1.CreateBookRequest');
  });

  it('returns undefined for a missing / unresolvable schema', () => {
    expect(inputDescriptorFor(undefined, 'lib.v1.Library', 'CreateBook')).toBeUndefined();
    expect(
      inputDescriptorFor({ kind: 'proto', fileName: 'x', text: PROTO }, 'lib.v1.Library', 'Nope')
    ).toBeUndefined();
  });
});

describe('resolveViolationPath', () => {
  const doc = {
    book: {
      displayName: 'x',
      authors: [{ givenName: 'a' }, { given_name: 'b', emailAddress: 'nope' }],
      tags: ['t0', 't1'],
    },
    labels: { 'k.x': 'v' },
  };

  it('maps proto names to the json_name keys in the document (nested + repeated)', () => {
    expect(resolveViolationPath(parseFieldPath('book.display_name'), doc, input)).toEqual({
      path: ['book', 'displayName'],
      exact: true,
    });
    expect(
      resolveViolationPath(parseFieldPath('book.authors[1].email_address'), doc, input)
    ).toEqual({ path: ['book', 'authors', 1, 'emailAddress'], exact: true });
    expect(resolveViolationPath(parseFieldPath('book.tags[1]'), doc, input)).toEqual({
      path: ['book', 'tags', 1],
      exact: true,
    });
  });

  it('accepts a proto-named key the user typed instead of the json name', () => {
    expect(resolveViolationPath(parseFieldPath('book.authors[1].given_name'), doc, input)).toEqual({
      path: ['book', 'authors', 1, 'given_name'],
      exact: true,
    });
  });

  it('falls back to lowerCamelCase without a descriptor, and handles map keys', () => {
    expect(resolveViolationPath(parseFieldPath('book.authors[0].given_name'), doc)).toEqual({
      path: ['book', 'authors', 0, 'givenName'],
      exact: true,
    });
    expect(resolveViolationPath(parseFieldPath('labels["k.x"]'), doc)).toEqual({
      path: ['labels', 'k.x'],
      exact: true,
    });
  });

  it('stops at the deepest existing node for a missing field or out-of-range index', () => {
    expect(resolveViolationPath(parseFieldPath('book.isbn'), doc, input)).toEqual({
      path: ['book'],
      exact: false,
    });
    expect(resolveViolationPath(parseFieldPath('book.authors[5].given_name'), doc, input)).toEqual({
      path: ['book', 'authors'],
      exact: false,
    });
  });
});

describe('locateFieldViolations', () => {
  const text = `{
  "parent": "shelves/1",
  "book": {
    "displayName": "",
    "authors": [
      { "givenName": "Ann" },
      { "givenName": "Bob", "emailAddress": "not-an-email" }
    ]
  }
}`;

  it('returns editor ranges covering the offending "key": value', () => {
    const [name, email] = locateFieldViolations(
      text,
      [
        { field: 'book.display_name', description: 'required' },
        { field: 'book.authors[1].email_address', description: 'invalid email' },
      ],
      input
    );
    expect(textAt(text, name?.range ?? null)).toBe('"displayName": ""');
    expect(email?.exact).toBe(true);
    expect(textAt(text, email?.range ?? null)).toBe('"emailAddress": "not-an-email"');
  });

  it('points a missing field at its parent, and the root at its opening brace', () => {
    const [isbn, top] = locateFieldViolations(
      text,
      [
        { field: 'book.isbn', description: 'required' },
        { field: 'request_id', description: 'required' },
      ],
      input
    );
    expect(isbn?.exact).toBe(false);
    expect(textAt(text, isbn?.range ?? null)?.startsWith('"book": {')).toBe(true);
    expect(top?.path).toEqual([]);
    expect(textAt(text, top?.range ?? null)).toBe('{');
  });

  it('still locates fields when an unresolved {{var}} breaks strict JSON', () => {
    const templated = '{ "book": { "displayName": {{name}}, "tags": ["a"] } }';
    const [tag] = locateFieldViolations(
      templated,
      [{ field: 'book.tags[0]', description: 'bad tag' }],
      input
    );
    expect(textAt(templated, tag?.range ?? null)).toBe('"a"');
  });
});
