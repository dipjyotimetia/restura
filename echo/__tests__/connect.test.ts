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

const REFLECTION_V1_PATH = '/grpc.reflection.v1.ServerReflection/ServerReflectionInfo';
const REFLECTION_V1ALPHA_PATH = '/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo';

// Connect streaming envelope: flags u8 + length u32be + payload.
function encodeEnvelope(flags: number, json: unknown): ArrayBuffer {
  const payload = new TextEncoder().encode(JSON.stringify(json));
  const buf = new Uint8Array(5 + payload.length);
  buf[0] = flags;
  new DataView(buf.buffer).setUint32(1, payload.length, false);
  buf.set(payload, 5);
  return buf.buffer;
}

function decodeEnvelopes(buf: Uint8Array): Array<{ flags: number; json: unknown }> {
  const frames: Array<{ flags: number; json: unknown }> = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const flags = buf[offset] as number;
    const len = view.getUint32(offset + 1, false);
    const payload = new TextDecoder().decode(buf.subarray(offset + 5, offset + 5 + len));
    frames.push({ flags, json: payload.length > 0 ? JSON.parse(payload) : null });
    offset += 5 + len;
  }
  return frames;
}

async function connectReflect(request: unknown): Promise<Array<{ flags: number; json: unknown }>> {
  const res = await app.request(`http://localhost${REFLECTION_V1_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/connect+json' },
    body: encodeEnvelope(0, request),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('connect+json');
  return decodeEnvelopes(new Uint8Array(await res.arrayBuffer()));
}

describe('reflection JSON shim (web Worker proxy path)', () => {
  it.each([REFLECTION_V1_PATH, REFLECTION_V1ALPHA_PATH])(
    'answers listServices as plain JSON at %s',
    async (path) => {
      const res = await app.request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ listServices: '' }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        listServicesResponse: { service: Array<{ name: string }> };
      };
      expect(data.listServicesResponse.service).toEqual([{ name: 'echo.v1.EchoService' }]);
    }
  );

  it('answers fileContainingSymbol with base64 descriptor bytes', async () => {
    const res = await app.request(`http://localhost${REFLECTION_V1_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileContainingSymbol: 'echo.v1.EchoService' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      fileDescriptorResponse: { fileDescriptorProto: string[] };
    };
    expect(data.fileDescriptorResponse.fileDescriptorProto).toHaveLength(1);
    expect(typeof data.fileDescriptorResponse.fileDescriptorProto[0]).toBe('string');
  });
});

describe('reflection over Connect protocol (desktop fallback path)', () => {
  it('listServices returns the echo service plus an end-of-stream frame', async () => {
    const frames = await connectReflect({ listServices: '' });
    expect(frames.length).toBeGreaterThanOrEqual(2);
    const first = frames[0] as {
      flags: number;
      json: { listServicesResponse: { service: Array<{ name: string }> } };
    };
    expect(first.flags).toBe(0);
    expect(first.json.listServicesResponse.service).toEqual([{ name: 'echo.v1.EchoService' }]);
    // Connect end-of-stream frame carries flag 0x02
    expect(frames[frames.length - 1]?.flags).toBe(2);
  });

  it('fileContainingSymbol returns descriptor bytes (base64 in JSON encoding)', async () => {
    const frames = await connectReflect({ fileContainingSymbol: 'echo.v1.EchoService' });
    const first = frames[0] as {
      flags: number;
      json: { fileDescriptorResponse: { fileDescriptorProto: string[] } };
    };
    expect(first.json.fileDescriptorResponse.fileDescriptorProto).toHaveLength(1);
  });

  it('unsupported request kind returns errorResponse NOT_FOUND', async () => {
    const frames = await connectReflect({ allExtensionNumbersOfType: 'echo.v1.EchoRequest' });
    const first = frames[0] as {
      flags: number;
      json: { errorResponse: { errorCode: number } };
    };
    expect(first.json.errorResponse.errorCode).toBe(5);
  });
});
