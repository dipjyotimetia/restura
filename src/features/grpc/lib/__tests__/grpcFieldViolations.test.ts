import { create, toBinary } from '@bufbuild/protobuf';
import {
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  FileDescriptorProtoSchema,
} from '@bufbuild/protobuf/wkt';
import { bytesToBase64 } from '@shared/protocol/binary';
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

describe('malformed BadRequest payloads', () => {
  it('skips non-array violation lists and non-object entries, blanking non-string fields', () => {
    expect(
      fieldViolationsOf([
        { type: 'google.rpc.BadRequest', value: { fieldViolations: 'nope' } },
        {
          type: 'google.rpc.BadRequest',
          value: { fieldViolations: [null, 7, { field: 42, description: 'D', reason: '' }] },
        },
      ])
    ).toEqual([{ field: '', description: 'D' }]);
  });

  it('ignores empty bracket segments', () => {
    expect(parseFieldPath('items[].name')).toEqual(['items', 'name']);
  });
});

describe('map fields resolved through the descriptor', () => {
  // A reflection snapshot (descriptor kind), as servers report map fields:
  // a repeated synthetic `*Entry` message with `map_entry = true`.
  const T = FieldDescriptorProto_Type;
  const L = FieldDescriptorProto_Label;
  const entry = (name: string, value: Partial<{ type: number; typeName: string }>) => ({
    name,
    options: { mapEntry: true },
    field: [
      { name: 'key', number: 1, type: T.STRING, label: L.OPTIONAL, jsonName: 'key' },
      { name: 'value', number: 2, label: L.OPTIONAL, jsonName: 'value', type: T.STRING, ...value },
    ],
  });
  const file = create(FileDescriptorProtoSchema, {
    name: 'inv.proto',
    package: 'inv.v1',
    syntax: 'proto3',
    messageType: [
      {
        name: 'PutRequest',
        field: [
          {
            name: 'items_by_sku',
            jsonName: 'itemsBySku',
            number: 1,
            label: L.REPEATED,
            type: T.MESSAGE,
            typeName: '.inv.v1.PutRequest.ItemsBySkuEntry',
          },
          {
            name: 'labels',
            jsonName: 'labels',
            number: 2,
            label: L.REPEATED,
            type: T.MESSAGE,
            typeName: '.inv.v1.PutRequest.LabelsEntry',
          },
          { name: 'count', jsonName: 'count', number: 3, label: L.OPTIONAL, type: T.INT32 },
        ],
        nestedType: [
          entry('ItemsBySkuEntry', { type: T.MESSAGE, typeName: '.inv.v1.Item' }),
          entry('LabelsEntry', {}),
        ],
      },
      {
        name: 'Item',
        field: [
          {
            name: 'display_name',
            jsonName: 'displayName',
            number: 1,
            label: L.OPTIONAL,
            type: T.STRING,
          },
        ],
      },
    ],
    service: [
      {
        name: 'Inventory',
        method: [
          { name: 'Put', inputType: '.inv.v1.PutRequest', outputType: '.inv.v1.PutRequest' },
        ],
      },
    ],
  });
  const mapInput = inputDescriptorFor(
    {
      kind: 'descriptors',
      descriptors: [bytesToBase64(toBinary(FileDescriptorProtoSchema, file))],
    },
    'inv.v1.Inventory',
    'Put'
  );
  const doc = {
    itemsBySku: { 'sku-1': { displayName: 'Widget' } },
    labels: { env: 'prod' },
    count: 3,
  };

  it('descends into message-valued map entries by key', () => {
    expect(
      resolveViolationPath(parseFieldPath('items_by_sku["sku-1"].display_name'), doc, mapInput)
    ).toEqual({ path: ['itemsBySku', 'sku-1', 'displayName'], exact: true });
  });

  it('stops at the map for a missing key, and treats scalar map values as leaves', () => {
    expect(
      resolveViolationPath(parseFieldPath('items_by_sku["sku-9"].display_name'), doc, mapInput)
    ).toEqual({ path: ['itemsBySku'], exact: false });
    expect(resolveViolationPath(parseFieldPath('labels.env'), doc, mapInput)).toEqual({
      path: ['labels', 'env'],
      exact: true,
    });
  });

  it('reports a path that runs through a scalar on the scalar itself', () => {
    expect(resolveViolationPath(parseFieldPath('count.value'), doc, mapInput)).toEqual({
      path: ['count'],
      exact: false,
    });
  });

  it('returns no descriptor for an empty reflection snapshot', () => {
    expect(
      inputDescriptorFor({ kind: 'descriptors', descriptors: [] }, 'inv.v1.Inventory', 'Put')
    ).toBeUndefined();
  });
});

describe('unlocatable violations', () => {
  it('keeps violations listed with no range when the text has no JSON tree', () => {
    const [v] = locateFieldViolations('', [{ field: 'a', description: 'required' }]);
    expect(v).toMatchObject({ field: 'a', path: [], exact: false, range: null });
  });

  it('marks only the first character when the document root is not an object', () => {
    const text = '"just a string"';
    const [v] = locateFieldViolations(text, [{ field: 'a.b', description: 'x' }]);
    expect(v).toMatchObject({ path: [], exact: false, range: { start: 0, end: 1 } });
  });
});
