import { describe, expect, it } from 'vitest';
import {
  downloadExtension,
  downloadFileName,
  downloadMime,
  filterHeaders,
  headersToText,
} from './responseFiles';

const headers: Array<[string, string | string[]]> = [
  ['content-type', 'application/json'],
  ['set-cookie', ['a=1; Path=/', 'session=xyz; HttpOnly']],
  ['x-request-id', 'abc'],
];

describe('response headers', () => {
  it('filters by name or any value, case-insensitively', () => {
    expect(filterHeaders(headers, 'JSON').map(([k]) => k)).toEqual(['content-type']);
    expect(filterHeaders(headers, 'session').map(([k]) => k)).toEqual(['set-cookie']);
    expect(filterHeaders(headers, 'x-req').map(([k]) => k)).toEqual(['x-request-id']);
    expect(filterHeaders(headers, '  ')).toBe(headers);
  });

  it('copies all headers with one line per set-cookie value', () => {
    expect(headersToText(headers)).toBe(
      'content-type: application/json\nset-cookie: a=1; Path=/\nset-cookie: session=xyz; HttpOnly\nx-request-id: abc'
    );
  });
});

describe('response downloads', () => {
  it('picks extensions for binary, CSV and text languages', () => {
    const opts = { isBase64: false, language: 'json', isCsv: false };
    expect(downloadExtension('image/png', { ...opts, isBase64: true })).toBe('png');
    expect(downloadExtension('text/csv', { ...opts, isCsv: true })).toBe('csv');
    expect(downloadExtension('application/json', opts)).toBe('json');
    expect(downloadExtension('text/html', { ...opts, language: 'html' })).toBe('html');
    expect(downloadExtension('application/xml', { ...opts, language: 'xml' })).toBe('xml');
    expect(downloadExtension('text/plain', { ...opts, language: 'text' })).toBe('txt');
  });

  it('keeps the response MIME type, defaulting by encoding', () => {
    expect(downloadMime('application/json; charset=utf-8', false)).toBe(
      'application/json; charset=utf-8'
    );
    expect(downloadMime('', false)).toBe('text/plain;charset=utf-8');
    expect(downloadMime(' ', true)).toBe('application/octet-stream');
  });

  it('builds a safe file name from the request name', () => {
    expect(downloadFileName('Get users', 'json')).toBe('Get users.json');
    expect(downloadFileName('../../etc/passwd', 'txt')).toBe('etc passwd.txt');
    expect(downloadFileName('a<b>:c|d?\u0007e', 'txt')).toBe('a b c d e.txt');
    expect(downloadFileName('...', 'txt')).toBe('response.txt');
    expect(downloadFileName(undefined, 'bin')).toBe('response.bin');
    expect(downloadFileName('x'.repeat(200), 'json')).toBe(`${'x'.repeat(80)}.json`);
  });
});
