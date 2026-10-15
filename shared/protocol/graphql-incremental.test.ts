import { describe, expect, it } from 'vitest';
import {
  GraphQLIncrementalMerger,
  mergeMultipartGraphQLBody,
  parseIncrementalPart,
} from './graphql-incremental';
import { MultipartMixedParser } from './multipart-mixed-parser';

/**
 * Fixture: a graphql-yoga (v5, @graphql-tools/executor, deferSpec=20220824)
 * response to
 *
 *   query { hello ... @defer(label: "slow") { slowField } list @stream(initialCount: 1) }
 *
 * framed exactly as yoga's multipart result processor writes it.
 */
const YOGA_CONTENT_TYPE = 'multipart/mixed; boundary="-"';
const yogaPart = (json: string) =>
  `\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${
    new TextEncoder().encode(json).byteLength
  }\r\n\r\n${json}\r\n---`;
const YOGA_DEFER_STREAM_BODY =
  '\r\n---' +
  yogaPart('{"data":{"hello":"world","list":["a"]},"hasNext":true}') +
  yogaPart('{"incremental":[{"items":["b"],"path":["list",1]}],"hasNext":true}') +
  yogaPart(
    '{"incremental":[{"data":{"slowField":"done"},"path":[],"label":"slow"},{"items":["c","d"],"path":["list",2]}],"hasNext":true}'
  ) +
  yogaPart('{"hasNext":false}') +
  '\r\n-----\r\n';

describe('mergeMultipartGraphQLBody — graphql-yoga fixture', () => {
  it('merges @defer and @stream patches into one ordinary result', () => {
    const merged = mergeMultipartGraphQLBody(YOGA_DEFER_STREAM_BODY, YOGA_CONTENT_TYPE);
    expect(merged).toEqual({
      result: { data: { hello: 'world', list: ['a', 'b', 'c', 'd'], slowField: 'done' } },
      parts: 4,
      hasNext: false,
    });
  });

  it('renders incrementally: each part yields a progressively merged snapshot', () => {
    const parser = new MultipartMixedParser('-');
    const merger = new GraphQLIncrementalMerger();
    const snapshots: unknown[] = [];
    for (const byte of new TextEncoder().encode(YOGA_DEFER_STREAM_BODY)) {
      for (const part of parser.feed(new Uint8Array([byte]))) {
        merger.apply(parseIncrementalPart(part.body));
        snapshots.push(structuredClone(merger.result));
      }
    }
    for (const part of parser.flush()) merger.apply(parseIncrementalPart(part.body));
    expect(snapshots[0]).toEqual({ data: { hello: 'world', list: ['a'] } });
    expect(snapshots[1]).toEqual({ data: { hello: 'world', list: ['a', 'b'] } });
    expect(snapshots[2]).toEqual({
      data: { hello: 'world', list: ['a', 'b', 'c', 'd'], slowField: 'done' },
    });
    expect(merger.hasNext).toBe(false);
  });

  it('returns null for non-multipart, boundary-less or JSON-free bodies', () => {
    expect(mergeMultipartGraphQLBody('{"data":{}}', 'application/json')).toBeNull();
    expect(mergeMultipartGraphQLBody(YOGA_DEFER_STREAM_BODY, 'multipart/mixed')).toBeNull();
    expect(
      mergeMultipartGraphQLBody('--b\r\n\r\nnot json\r\n--b--', 'multipart/mixed; boundary=b')
    ).toBeNull();
  });
});

describe('GraphQLIncrementalMerger — newer incremental format (pending/completed ids)', () => {
  it('resolves paths through pending ids, subPath and appends streamed items', () => {
    const m = new GraphQLIncrementalMerger();
    m.apply({
      data: { user: { id: '1' }, friends: [] },
      pending: [
        { id: '0', path: ['user'], label: 'profile' },
        { id: '1', path: ['friends'] },
      ],
      hasNext: true,
    });
    m.apply({
      incremental: [
        { id: '0', data: { name: 'Ada' } },
        { id: '0', subPath: ['address'], data: { city: 'London' } },
        { id: '1', items: [{ id: 'f1' }] },
      ],
      completed: [{ id: '0' }],
      hasNext: true,
    });
    m.apply({
      incremental: [{ id: '1', items: [{ id: 'f2' }] }],
      completed: [{ id: '1', errors: [{ message: 'stream ended early' }] }],
      hasNext: false,
    });
    expect(m.result).toEqual({
      data: {
        user: { id: '1', name: 'Ada', address: { city: 'London' } },
        friends: [{ id: 'f1' }, { id: 'f2' }],
      },
      errors: [{ message: 'stream ended early' }],
    });
    expect(m.hasNext).toBe(false);
    expect(m.payloadCount).toBe(3);
  });
});

describe('GraphQLIncrementalMerger — edge cases', () => {
  it('accepts the pre-2022 top-level { data, path } patch', () => {
    const m = new GraphQLIncrementalMerger();
    m.apply({ data: { a: { b: 1 } }, hasNext: true });
    m.apply({ data: { c: 2 }, path: ['a'], hasNext: false });
    expect(m.result).toEqual({ data: { a: { b: 1, c: 2 } } });
  });

  it('collects errors and deep-merges extensions from every level', () => {
    const m = new GraphQLIncrementalMerger();
    m.apply({ data: { a: 1 }, errors: [{ message: 'e0' }], extensions: { t: { x: 1 } } });
    m.apply({
      incremental: [
        { data: { b: 2 }, path: [], errors: [{ message: 'e1' }], extensions: { t: { y: 2 } } },
      ],
      extensions: { cost: 3 },
    });
    expect(m.result).toEqual({
      data: { a: 1, b: 2 },
      errors: [{ message: 'e0' }, { message: 'e1' }],
      extensions: { t: { x: 1, y: 2 }, cost: 3 },
    });
  });

  it('merges a second top-level data payload and nested lists element-wise', () => {
    const m = new GraphQLIncrementalMerger();
    m.apply({ data: { l: [{ a: 1 }] } });
    m.apply({ data: { l: [{ b: 2 }, { c: 3 }] } });
    expect(m.result).toEqual({ data: { l: [{ a: 1, b: 2 }, { c: 3 }] } });
  });

  it('replaces a value whose shape changed between payloads', () => {
    const m = new GraphQLIncrementalMerger();
    m.apply({ data: { a: 'scalar' } });
    m.apply({ data: { a: { now: 'object' } } });
    expect(m.result).toEqual({ data: { a: { now: 'object' } } });
  });

  it('creates missing containers along a patch path (objects and lists)', () => {
    const m = new GraphQLIncrementalMerger();
    m.apply({ incremental: [{ data: { name: 'x' }, path: ['users', 0] }] });
    m.apply({ incremental: [{ items: ['a'], path: ['tags', 0] }] });
    expect(m.result).toEqual({ data: { users: [{ name: 'x' }], tags: ['a'] } });
  });

  it('ignores heartbeats, non-objects and malformed incremental entries', () => {
    const m = new GraphQLIncrementalMerger();
    m.apply({});
    m.apply('nope');
    m.apply({ data: { a: 1 } });
    m.apply({
      incremental: [
        null,
        { data: { z: 1 } }, // no path
        { id: 'unknown', items: [1] }, // unknown id, no path
        { items: [1], path: ['a', 'nope'] }, // non-numeric index
        { items: [1], path: [] }, // empty path
      ],
      completed: [null, { id: 7 }],
      pending: [null, { id: 3, path: [] }],
    });
    expect(m.result).toEqual({ data: { a: 1 } });
    expect(m.payloadCount).toBe(2);
  });

  it('refuses to patch through or onto prototype keys', () => {
    const m = new GraphQLIncrementalMerger();
    m.apply({ data: { a: {} } });
    m.apply(JSON.parse('{"data":{"__proto__":{"polluted":true}},"path":["a"]}'));
    m.apply({ incremental: [{ data: { polluted: true }, path: ['__proto__'] }] });
    m.apply({ incremental: [{ data: { polluted: true }, path: ['a', '__proto__', 'x'] }] });
    m.apply({ incremental: [{ items: [1], path: ['constructor', 0] }] });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(m.result).toEqual({ data: { a: {} } });
  });

  it('does not patch into scalar data or through scalar nodes', () => {
    const m = new GraphQLIncrementalMerger();
    m.apply({ data: 5 });
    m.apply({ incremental: [{ data: { b: 1 }, path: ['a'] }] });
    expect(m.result).toEqual({ data: 5 });

    const n = new GraphQLIncrementalMerger();
    n.apply({ data: { a: 'str', l: 'x' } });
    n.apply({ incremental: [{ data: { b: 1 }, path: ['a', 'deep'] }] });
    n.apply({ incremental: [{ items: [1], path: ['l', 0] }] });
    expect(n.result).toEqual({ data: { a: 'str', l: 'x' } });
  });

  it('merges a root-path patch even before any initial data', () => {
    const m = new GraphQLIncrementalMerger();
    m.apply({ incremental: [{ data: { a: 1 }, path: [] }] });
    m.apply({ incremental: [{ data: { b: 2 }, path: [] }] });
    expect(m.result).toEqual({ data: { a: 1, b: 2 } });
  });

  it('parseIncrementalPart returns undefined for non-JSON', () => {
    expect(parseIncrementalPart('{"a":1}')).toEqual({ a: 1 });
    expect(parseIncrementalPart('nope')).toBeUndefined();
  });
});
