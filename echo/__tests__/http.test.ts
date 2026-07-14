// @vitest-environment node
import { describe, expect, it } from 'vitest';
import app from '../index';

interface EchoResponse {
  echo: boolean;
  timestamp: string;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string | null;
  bodyTruncated: boolean;
  bodySize: number;
}

describe('httpEcho handler', () => {
  it('GET with no body returns echo:true, method GET, body null, bodyTruncated false', async () => {
    const res = await app.request('http://localhost/hello', {
      method: 'GET',
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as EchoResponse;
    expect(json.echo).toBe(true);
    expect(json.method).toBe('GET');
    expect(json.body).toBeNull();
    expect(json.bodyTruncated).toBe(false);
    expect(json.bodySize).toBe(0);
    expect(json.path).toBe('/hello');
  });

  it('POST with JSON body echoes body correctly and bodySize > 0', async () => {
    const payload = JSON.stringify({ hello: 'world' });
    const res = await app.request('http://localhost/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as EchoResponse;
    expect(json.echo).toBe(true);
    expect(json.method).toBe('POST');
    expect(json.body).toBe(payload);
    expect(json.bodySize).toBeGreaterThan(0);
    expect(json.bodyTruncated).toBe(false);
  });

  it('POST with body > 1MB sets bodyTruncated:true and body is partial', async () => {
    // 1_048_576 + 1 byte to exceed the cap
    const largebody = 'x'.repeat(1_048_577);
    const res = await app.request('http://localhost/echo', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: largebody,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as EchoResponse;
    expect(json.bodyTruncated).toBe(true);
    // body should be shorter than the full payload (truncated)
    expect((json.body ?? '').length).toBeLessThan(largebody.length);
  });

  it('query params are echoed in the query field', async () => {
    const res = await app.request('http://localhost/search?foo=bar&baz=qux', {
      method: 'GET',
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as EchoResponse;
    expect(json.query).toEqual({ foo: 'bar', baz: 'qux' });
  });

  it('cf-* and x-forwarded-for headers are excluded; regular headers are included', async () => {
    const res = await app.request('http://localhost/echo', {
      method: 'GET',
      headers: {
        'cf-ray': 'abc123',
        'x-forwarded-for': '1.2.3.4',
        'x-custom': 'keep-me',
      },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as EchoResponse;
    expect(json.headers['cf-ray']).toBeUndefined();
    expect(json.headers['x-forwarded-for']).toBeUndefined();
    expect(json.headers['x-custom']).toBe('keep-me');
  });
});
