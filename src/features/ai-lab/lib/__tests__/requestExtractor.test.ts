import { describe, expect, it } from 'vitest';
import { extractGraphqlSpec, extractRequestSpec } from '../requestExtractor';

describe('extractRequestSpec', () => {
  it('parses a bare JSON object', () => {
    const r = extractRequestSpec(
      '{"method":"post","url":"https://api.test/x","body":{"a":1}}',
      'json'
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.method).toBe('POST');
      expect(r.request.url).toBe('https://api.test/x');
      expect(r.request.body).toBe('{"a":1}');
    }
  });

  it('extracts JSON embedded in prose', () => {
    const r = extractRequestSpec('Sure! {"url":"https://x.test"} done', 'json');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.method).toBe('GET');
  });

  it('reads a fenced ```json block', () => {
    const text = 'Here:\n```json\n{"method":"GET","url":"https://x.test/y"}\n```\nthanks';
    const r = extractRequestSpec(text, 'fenced');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.url).toBe('https://x.test/y');
  });

  it('fails on missing url', () => {
    const r = extractRequestSpec('{"method":"GET"}', 'json');
    expect(r.ok).toBe(false);
  });

  it('fails on an unsupported method', () => {
    const r = extractRequestSpec('{"method":"TRACE","url":"https://x"}', 'json');
    expect(r.ok).toBe(false);
  });

  it('follows the shared method policy (#857)', () => {
    const method = (m: string) => {
      const r = extractRequestSpec(JSON.stringify({ method: m, url: 'https://x.test' }), 'json');
      return r.ok ? r.request.method : `error: ${r.error}`;
    };
    expect(method('propFind')).toBe('propFind');
    expect(method('QUERY')).toBe('QUERY');
    expect(method('patch')).toBe('PATCH');
    expect(method('track')).toMatch(/^error: .*not allowed/);
    expect(method('BAD METHOD')).toMatch(/^error: .*not a valid HTTP method token/);
  });

  it('fails on non-JSON', () => {
    const r = extractRequestSpec('no json here', 'json');
    expect(r.ok).toBe(false);
  });

  it('normalizes header values to strings', () => {
    const r = extractRequestSpec('{"url":"https://x","headers":{"x-n":5,"x-s":"a"}}', 'json');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.headers).toEqual({ 'x-n': '5', 'x-s': 'a' });
  });
});

describe('extractGraphqlSpec', () => {
  it('forces POST + json content type', () => {
    const r = extractGraphqlSpec('{"url":"https://gql.test","body":{"query":"{x}"}}', 'json');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.method).toBe('POST');
      expect(r.request.headers['content-type']).toBe('application/json');
    }
  });
});
