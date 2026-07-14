import { describe, expect, it } from 'vitest';
import { getHeaderDef, STANDARD_HTTP_HEADERS } from './http-headers';

describe('http-headers catalog', () => {
  it('contains the headers shown in the design reference', () => {
    const names = new Set(STANDARD_HTTP_HEADERS.map((h) => h.name));
    for (const expected of [
      'Accept',
      'Accept-Charset',
      'Accept-Encoding',
      'Accept-Language',
      'Authorization',
      'Cache-Control',
      'Content-Type',
      'Content-Length',
      'Cookie',
      'Host',
      'Origin',
      'Referer',
      'User-Agent',
      'x-api-key',
    ]) {
      expect(names.has(expected), `missing canonical header ${expected}`).toBe(true);
    }
  });

  it('has no duplicate header names (case-insensitive)', () => {
    const seen = new Map<string, string>();
    for (const h of STANDARD_HTTP_HEADERS) {
      const key = h.name.toLowerCase();
      const prior = seen.get(key);
      expect(prior, `duplicate header ${h.name} (also seen as ${prior})`).toBeUndefined();
      seen.set(key, h.name);
    }
  });

  it('Content-Type advertises application/json as its first default', () => {
    const def = getHeaderDef('Content-Type');
    expect(def?.values?.[0]).toBe('application/json');
  });

  it('Accept advertises application/json as its first default', () => {
    const def = getHeaderDef('Accept');
    expect(def?.values?.[0]).toBe('application/json');
  });

  it('getHeaderDef is case-insensitive', () => {
    const a = getHeaderDef('Content-Type');
    const b = getHeaderDef('content-type');
    const c = getHeaderDef('CONTENT-TYPE');
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('getHeaderDef returns undefined for unknown / empty input', () => {
    expect(getHeaderDef('X-Not-Real-Header')).toBeUndefined();
    expect(getHeaderDef('')).toBeUndefined();
    expect(getHeaderDef('   ')).toBeUndefined();
  });

  it('every catalog entry has a non-empty name', () => {
    for (const h of STANDARD_HTTP_HEADERS) {
      expect(h.name.trim().length).toBeGreaterThan(0);
    }
  });

  it('every catalog entry that declares values has at least one', () => {
    for (const h of STANDARD_HTTP_HEADERS) {
      if (h.values !== undefined) {
        expect(h.values.length).toBeGreaterThan(0);
      }
    }
  });
});
