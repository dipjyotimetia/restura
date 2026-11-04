import { describe, expect, it } from 'vitest';
import type { HttpRequest } from '@/types';
import { importCurlCommand } from '../importers/curl';

const reqOf = (cmd: string): HttpRequest =>
  importCurlCommand(cmd).collection.items[0]!.request as HttpRequest;

describe('curl importer: URL without scheme / templates', () => {
  it('accepts a scheme-less URL as http://', () => {
    const r = reqOf('curl example.com/path?x=1');
    expect(r.url).toBe('http://example.com/path');
    expect(r.name).toBe('GET example.com');
    expect(r.params).toEqual([expect.objectContaining({ key: 'x', value: '1' })]);
  });

  it('accepts {{var}} placeholders', () => {
    const r = reqOf("curl '{{baseUrl}}/users?limit=5'");
    expect(r.url).toBe('{{baseUrl}}/users');
    expect(r.params).toEqual([expect.objectContaining({ key: 'limit', value: '5' })]);
  });

  it('still rejects garbage', () => {
    expect(() => importCurlCommand('curl http://')).toThrow();
  });
});

describe('curl importer: double-quote backslashes', () => {
  it('keeps backslashes that are not escapes', () => {
    const r = reqOf('curl https://a.test -H "X: C:\\path\\n"');
    expect(r.headers.find((h) => h.key === 'X')?.value).toBe('C:\\path\\n');
  });

  it('still unescapes \\" \\\\ \\$ and \\`', () => {
    const r = reqOf('curl https://a.test -H "X: a\\"b\\\\c\\$d\\`e"');
    expect(r.headers.find((h) => h.key === 'X')?.value).toBe('a"b\\c$d`e');
  });
});

describe('curl importer: empty headers', () => {
  it("imports -H 'X-Empty;' as an empty-valued header", () => {
    const r = reqOf("curl https://a.test -H 'X-Empty;'");
    expect(r.headers).toEqual([
      expect.objectContaining({ key: 'X-Empty', value: '', enabled: true }),
    ]);
  });

  it("does not import -H 'Accept:' as an enabled empty header", () => {
    const result = importCurlCommand("curl https://a.test -H 'Accept:'");
    const r = result.collection.items[0]!.request as HttpRequest;
    expect(r.headers.filter((h) => h.enabled && h.key === 'Accept')).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
