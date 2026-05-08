import { describe, it, expect } from 'vitest';
import { sanitizeRequestHeaders, sanitizeResponseHeaders, REQUEST_DENY, RESPONSE_DENY } from './header-policy';

describe('sanitizeRequestHeaders', () => {
  it('strips hop-by-hop headers', () => {
    const out = sanitizeRequestHeaders({
      Host: 'attacker.example.com',
      Connection: 'close',
      Authorization: 'Bearer xyz',
      'X-Custom': 'ok',
    });
    expect(out).toEqual({
      Authorization: 'Bearer xyz',
      'X-Custom': 'ok',
    });
  });

  it('is case-insensitive on header names', () => {
    const out = sanitizeRequestHeaders({ HOST: 'foo' });
    expect(out).toEqual({});
  });

  it('returns empty object for undefined input', () => {
    expect(sanitizeRequestHeaders(undefined)).toEqual({});
  });

  it('strips Cookie when policy is "mcp"', () => {
    const out = sanitizeRequestHeaders({ Cookie: 'session=1', Authorization: 'Bearer x' }, 'mcp');
    expect(out).toEqual({ Authorization: 'Bearer x' });
  });

  it('keeps Cookie under default policy', () => {
    const out = sanitizeRequestHeaders({ Cookie: 'session=1' });
    expect(out).toEqual({ Cookie: 'session=1' });
  });

  it('strips proxy-authorization under default policy', () => {
    const out = sanitizeRequestHeaders({ 'Proxy-Authorization': 'Basic xyz', 'X-OK': 'yes' });
    expect(out).toEqual({ 'X-OK': 'yes' });
  });
});

describe('sanitizeResponseHeaders', () => {
  it('strips hop-by-hop response headers from a plain object', () => {
    const out = sanitizeResponseHeaders({
      'Transfer-Encoding': 'chunked',
      'Content-Type': 'application/json',
      Trailer: 'Expires',
    });
    expect(out).toEqual({ 'Content-Type': 'application/json' });
  });

  it('joins array-valued headers (e.g. Set-Cookie list) into a single comma-delimited string', () => {
    const out = sanitizeResponseHeaders({
      'Set-Cookie': ['a=1', 'b=2'],
      'Content-Type': 'application/json',
    });
    expect(out['Set-Cookie']).toBe('a=1, b=2');
    expect(out['Content-Type']).toBe('application/json');
  });

  it('handles a Headers instance and is case-insensitive on the deny check', () => {
    const headers = new Headers();
    headers.set('Transfer-Encoding', 'chunked');
    headers.set('Content-Type', 'application/json');
    headers.set('Connection', 'keep-alive');
    const out = sanitizeResponseHeaders(headers);
    expect(out['content-type']).toBe('application/json');
    expect(Object.keys(out).map((k) => k.toLowerCase())).not.toContain('transfer-encoding');
    expect(Object.keys(out).map((k) => k.toLowerCase())).not.toContain('connection');
  });
});

describe('exported deny lists', () => {
  it('REQUEST_DENY contains the expected hop-by-hop request headers', () => {
    expect(REQUEST_DENY.has('host')).toBe(true);
    expect(REQUEST_DENY.has('content-length')).toBe(true);
    expect(REQUEST_DENY.has('transfer-encoding')).toBe(true);
    expect(REQUEST_DENY.has('upgrade')).toBe(true);
    expect(REQUEST_DENY.has('proxy-authorization')).toBe(true);
  });
  it('RESPONSE_DENY contains the expected hop-by-hop response headers', () => {
    expect(RESPONSE_DENY.has('transfer-encoding')).toBe(true);
    expect(RESPONSE_DENY.has('connection')).toBe(true);
    expect(RESPONSE_DENY.has('keep-alive')).toBe(true);
    expect(RESPONSE_DENY.has('trailer')).toBe(true);
    expect(RESPONSE_DENY.has('upgrade')).toBe(true);
  });
});
