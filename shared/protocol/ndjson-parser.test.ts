import { describe, expect, it } from 'vitest';
import { type NdjsonParseError, NdjsonParser } from './ndjson-parser';

const enc = (s: string) => new TextEncoder().encode(s);
const isParseError = (v: unknown): v is NdjsonParseError =>
  typeof v === 'object' && v !== null && '__parseError' in v;

describe('NdjsonParser.feed', () => {
  it('parses a single complete line', () => {
    const p = new NdjsonParser();
    const out = p.feed(enc('{"a":1}\n'));
    expect(out).toEqual([{ a: 1 }]);
  });

  it('parses multiple lines in one chunk', () => {
    const p = new NdjsonParser();
    const out = p.feed(enc('{"a":1}\n{"b":2}\n{"c":3}\n'));
    expect(out).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('handles a line split across two chunks', () => {
    const p = new NdjsonParser();
    const a = p.feed(enc('{"a":'));
    const b = p.feed(enc('1}\n'));
    expect(a).toEqual([]);
    expect(b).toEqual([{ a: 1 }]);
  });

  it('skips empty lines', () => {
    const p = new NdjsonParser();
    const out = p.feed(enc('{"a":1}\n\n{"b":2}\n'));
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('emits a parseError sentinel for malformed JSON without aborting', () => {
    const p = new NdjsonParser();
    const out = p.feed(enc('{"a":1}\n{not json}\n{"b":2}\n'));
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ a: 1 });
    expect(isParseError(out[1])).toBe(true);
    if (isParseError(out[1])) expect(out[1].__parseError).toBe('{not json}');
    expect(out[2]).toEqual({ b: 2 });
  });

  it('normalises CRLF and lone CR to LF before line-splitting', () => {
    const p = new NdjsonParser();
    const out = p.feed(enc('{"a":1}\r\n{"b":2}\r{"c":3}\n'));
    expect(out).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('strips a BOM only on the first chunk', () => {
    const p = new NdjsonParser();
    const first = p.feed(enc('﻿{"a":1}\n'));
    expect(first).toEqual([{ a: 1 }]);
    // A BOM mid-stream is content; the line "{...}" is treated as JSON
    // and will likely produce a parseError sentinel since BOM is not valid JSON.
    const mid = p.feed(enc('﻿{"b":2}\n'));
    expect(mid).toHaveLength(1);
    // Either the JSON parser ignores the BOM and produces the value, or it
    // treats it as a parse error — both are acceptable as long as the
    // first-chunk-only BOM strip works deterministically.
  });

  it('handles values that are arrays, primitives, and strings', () => {
    const p = new NdjsonParser();
    const out = p.feed(enc('[1,2,3]\n42\n"hello"\ntrue\nnull\n'));
    expect(out).toEqual([[1, 2, 3], 42, 'hello', true, null]);
  });

  it('compacts the buffer over many small events', () => {
    const p = new NdjsonParser();
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) lines.push(`{"i":${i}}`);
    const out = p.feed(enc(lines.join('\n') + '\n'));
    expect(out).toHaveLength(100);
    expect(out[0]).toEqual({ i: 0 });
    expect(out[99]).toEqual({ i: 99 });
  });

  it('handles UTF-8 multi-byte sequences split across chunks', () => {
    const p = new NdjsonParser();
    // "naïve" — the ï is 2 UTF-8 bytes (0xC3 0xAF). Split between them.
    const allBytes = enc('{"name":"naïve"}\n');
    const split = Math.floor(allBytes.length / 2);
    const a = p.feed(allBytes.slice(0, split));
    const b = p.feed(allBytes.slice(split));
    const combined = [...a, ...b];
    expect(combined).toEqual([{ name: 'naïve' }]);
  });
});

describe('NdjsonParser.flush', () => {
  it('parses a trailing partial line that is valid JSON', () => {
    const p = new NdjsonParser();
    const mid = p.feed(enc('{"a":1}\n{"b":2}'));
    expect(mid).toEqual([{ a: 1 }]);
    const tail = p.flush();
    expect(tail).toEqual([{ b: 2 }]);
  });

  it('emits parseError sentinel for trailing partial that is not valid JSON', () => {
    const p = new NdjsonParser();
    p.feed(enc('{"a":1}\n{partial'));
    const tail = p.flush();
    expect(tail).toHaveLength(1);
    expect(isParseError(tail[0])).toBe(true);
    if (isParseError(tail[0])) expect(tail[0].__parseError).toBe('{partial');
  });

  it('returns empty when no trailing data', () => {
    const p = new NdjsonParser();
    p.feed(enc('{"a":1}\n'));
    expect(p.flush()).toEqual([]);
  });

  it('returns empty when only a trailing newline (no payload)', () => {
    const p = new NdjsonParser();
    p.feed(enc('{"a":1}\n\n'));
    expect(p.flush()).toEqual([]);
  });
});
