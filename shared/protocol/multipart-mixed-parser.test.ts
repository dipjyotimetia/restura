import { describe, expect, it } from 'vitest';
import {
  isMultipartMixed,
  MultipartMixedParser,
  parseMultipartBoundary,
  parseMultipartMixed,
} from './multipart-mixed-parser';

const enc = (s: string) => new TextEncoder().encode(s);

// Byte-for-byte what graphql-yoga's multipart result processor writes:
// `\r\n---` up front, then per result `\r\nContent-Type…\r\nContent-Length…\r\n\r\n<json>\r\n---`,
// then `\r\n-----\r\n` once the iterator completes.
const YOGA_BODY =
  '\r\n---' +
  '\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: 27\r\n\r\n{"data":{"a":1},"hasNext":true}\r\n---' +
  '\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: 20\r\n\r\n{"hasNext":false}\r\n---' +
  '\r\n-----\r\n';

// Apollo Server's wire shape: `--graphql` delimiters, lower-case headers.
const APOLLO_BODY =
  '\r\n--graphql\r\ncontent-type: application/json; charset=utf-8\r\n\r\n{"data":{"a":1},"hasNext":true}' +
  '\r\n--graphql\r\ncontent-type: application/json; charset=utf-8\r\n\r\n{"hasNext":false}' +
  '\r\n--graphql--\r\n';

describe('isMultipartMixed / parseMultipartBoundary', () => {
  it('recognises multipart/mixed regardless of case and params', () => {
    expect(isMultipartMixed('Multipart/Mixed; boundary="-"')).toBe(true);
    expect(isMultipartMixed('application/json')).toBe(false);
    expect(isMultipartMixed(undefined)).toBe(false);
  });

  it('extracts quoted and bare boundaries', () => {
    expect(parseMultipartBoundary('multipart/mixed; boundary="-"')).toBe('-');
    expect(parseMultipartBoundary('multipart/mixed;boundary=graphql;deferSpec=20220824')).toBe(
      'graphql'
    );
    expect(parseMultipartBoundary('multipart/mixed; deferSpec=20220824; BOUNDARY=x')).toBe('x');
  });

  it('rejects missing, empty, oversized or non-multipart boundaries', () => {
    expect(parseMultipartBoundary('multipart/mixed')).toBeNull();
    expect(parseMultipartBoundary('multipart/mixed; boundary=""')).toBeNull();
    expect(parseMultipartBoundary(`multipart/mixed; boundary=${'a'.repeat(71)}`)).toBeNull();
    expect(parseMultipartBoundary('application/json; boundary=x')).toBeNull();
    expect(parseMultipartBoundary(null)).toBeNull();
    expect(parseMultipartBoundary('multipart/mixed; charset')).toBeNull();
  });
});

describe('MultipartMixedParser', () => {
  it('parses a graphql-yoga body and drops the empty trailing part', () => {
    const parts = parseMultipartMixed(YOGA_BODY, '-');
    expect(parts.map((p) => p.body)).toEqual([
      '{"data":{"a":1},"hasNext":true}',
      '{"hasNext":false}',
    ]);
    expect(parts[0]?.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(parts[0]?.headers['content-length']).toBe('27');
  });

  it('parses an Apollo body', () => {
    const parts = parseMultipartMixed(APOLLO_BODY, 'graphql');
    expect(parts.map((p) => p.body)).toEqual([
      '{"data":{"a":1},"hasNext":true}',
      '{"hasNext":false}',
    ]);
  });

  it('emits each part as soon as the next delimiter arrives (byte-by-byte feed)', () => {
    const parser = new MultipartMixedParser('-');
    const seen: string[] = [];
    const bytes = enc(YOGA_BODY);
    let firstEmittedAt = -1;
    bytes.forEach((b, i) => {
      for (const part of parser.feed(new Uint8Array([b]))) {
        if (firstEmittedAt < 0) firstEmittedAt = i;
        seen.push(part.body);
      }
    });
    seen.push(...parser.flush().map((p) => p.body));
    expect(seen).toEqual(['{"data":{"a":1},"hasNext":true}', '{"hasNext":false}']);
    // The first part is available long before the stream ends.
    expect(firstEmittedAt).toBeLessThan(bytes.length / 2 + 20);
    expect(parser.done).toBe(true);
  });

  it('decodes multi-byte UTF-8 split across chunks', () => {
    const body = enc('--b\r\n\r\n{"s":"héllo"}\r\n--b--');
    const parser = new MultipartMixedParser('b');
    const split = body.indexOf(0xc3) + 1; // inside the 2-byte é
    const parts = [
      ...parser.feed(body.slice(0, split)),
      ...parser.feed(body.slice(split)),
      ...parser.flush(),
    ];
    expect(parts).toEqual([{ headers: {}, body: '{"s":"héllo"}' }]);
  });

  it('ignores a boundary string that does not start a line', () => {
    const parts = parseMultipartMixed('--b\n\n{"s":"a--b"}\n--b--\n', 'b');
    expect(parts.map((p) => p.body)).toEqual(['{"s":"a--b"}']);
  });

  it('discards the preamble and the epilogue', () => {
    const parts = parseMultipartMixed('preamble\r\n--b\r\n\r\nX\r\n--b--\r\nepilogue', 'b');
    expect(parts.map((p) => p.body)).toEqual(['X']);
  });

  it('accepts parts without headers or without the blank separator line', () => {
    const parts = parseMultipartMixed('--b\n{"a":1}\n--b\n\n{"b":2}\n--b--', 'b');
    expect(parts).toEqual([
      { headers: {}, body: '{"a":1}' },
      { headers: {}, body: '{"b":2}' },
    ]);
  });

  it('drops a part whose body is empty even when it has headers', () => {
    expect(parseMultipartMixed('--b\nX-A: 1\n\n\n--b--', 'b')).toEqual([]);
  });

  it('emits a trailing part when the stream ends without a closing delimiter', () => {
    const parser = new MultipartMixedParser('b');
    expect(parser.feed('--b\r\n\r\n{"a":1}\r\n--b\r\n\r\n{"b":2}')).toHaveLength(1);
    expect(parser.flush()).toEqual([{ headers: {}, body: '{"b":2}' }]);
    expect(parser.feed('more')).toEqual([]);
    expect(parser.flush()).toEqual([]);
  });

  it('treats a bare delimiter at end-of-stream as the close', () => {
    const parser = new MultipartMixedParser('b');
    expect(parser.feed('--b\n\nA\n--b')).toEqual([]);
    expect(parser.flush()).toEqual([{ headers: {}, body: 'A' }]);
  });

  it('waits for the delimiter line end before deciding close vs. next part', () => {
    const parser = new MultipartMixedParser('b');
    expect(parser.feed('--b\n\nA\n--b')).toEqual([]);
    expect(parser.feed('-')).toEqual([]);
    expect(parser.feed('-\n')).toEqual([{ headers: {}, body: 'A' }]);
    expect(parser.done).toBe(true);
  });

  it('throws when a part grows past the cap', () => {
    const parser = new MultipartMixedParser('b', { maxPartChars: 16 });
    parser.feed('--b\n\n');
    expect(() => parser.feed('x'.repeat(32))).toThrow(/exceeds 16/);
  });
});
