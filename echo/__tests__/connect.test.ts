// @vitest-environment node
import { describe, it, expect } from 'vitest';
import app from '../index';

const CONNECT_HEADERS = {
  'content-type': 'application/json',
  'connect-protocol-version': '1',
};

describe('connectEcho handler', () => {
  it('UnaryEcho returns echoed message', async () => {
    const res = await app.request('http://localhost/echo.v1.EchoService/UnaryEcho', {
      method: 'POST',
      headers: CONNECT_HEADERS,
      body: JSON.stringify({ message: 'hello', count: 0 }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { message: string; index?: number };
    expect(data.message).toBe('echo: hello');
    // proto3 JSON omits default (zero) values — index 0 is not emitted
    expect(data.index ?? 0).toBe(0);
  });

  it('UnaryEcho with empty message echoes correctly', async () => {
    const res = await app.request('http://localhost/echo.v1.EchoService/UnaryEcho', {
      method: 'POST',
      headers: CONNECT_HEADERS,
      body: JSON.stringify({ message: '', count: 0 }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { message: string; index: number };
    expect(data.message).toBe('echo: ');
  });

  it('ServerStreamingEcho returns streaming response', async () => {
    // Server-streaming over Connect protocol requires application/connect+json
    const res = await app.request('http://localhost/echo.v1.EchoService/ServerStreamingEcho', {
      method: 'POST',
      headers: { 'content-type': 'application/connect+json' },
      body: JSON.stringify({ message: 'hi', count: 3 }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('connect+json');
    await res.body?.cancel();
  });

  it('non-matching path falls through to HTTP echo handler', async () => {
    const res = await app.request('http://localhost/not/a/grpc/path', {
      method: 'POST',
      headers: CONNECT_HEADERS,
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(res.status).toBe(200);
    // HTTP echo returns the echo shape, not a Connect response
    const data = (await res.json()) as { echo: boolean };
    expect(data.echo).toBe(true);
  });

  it('unimplemented path within service namespace falls through to HTTP echo', async () => {
    const res = await app.request('http://localhost/echo.v1.EchoService/NonExistentMethod', {
      method: 'POST',
      headers: CONNECT_HEADERS,
      body: JSON.stringify({}),
    });
    // No handler registered for this method → falls through to httpEcho
    expect(res.status).toBe(200);
    const data = (await res.json()) as { echo: boolean; path: string };
    expect(data.echo).toBe(true);
    expect(data.path).toBe('/echo.v1.EchoService/NonExistentMethod');
  });
});
