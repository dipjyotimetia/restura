/**
 * gRPC-Web renderer client (#914) against a scripted `/api/grpc-web` relay:
 * Worker rejections, NDJSON edge cases, schema-source selection and request
 * preparation. The full-stack path (real relay + real gRPC-Web server) lives in
 * grpcWebClient.test.ts.
 */
import { create, toBinary } from '@bufbuild/protobuf';
import { descriptorsFromProtoFiles, registryFromProtoText } from '@shared/protocol/grpc-registry';
import { bytesToBase64 } from '@shared/protocol/grpc-web-framing';
import type { GrpcWebEvent } from '@shared/protocol/grpc-web-proxy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrpcRequest } from '@/types';
import { GrpcStatusCode } from '@/types';

const platform = vi.hoisted(() => ({ electron: false }));
vi.mock('@/lib/shared/platform', async (orig) => ({
  ...(await orig<typeof import('@/lib/shared/platform')>()),
  isElectron: () => platform.electron,
}));

import {
  canUseDescriptorSnapshot,
  makeGrpcWebRequest,
  prepareGrpcWebCall,
  registryForGrpcWeb,
  streamGrpcWebViaWorker,
} from '../grpcWebClient';
import { startGrpcStream } from '../grpcStreamingClient';

const PROTO = `syntax = "proto3";
package demo.v1;
message Ping { string text = 1; }
message Pong { string text = 1; }
service Demo {
  rpc Echo(Ping) returns (Pong);
  rpc Watch(Ping) returns (stream Pong);
}`;
const DESCRIPTORS = descriptorsFromProtoFiles([{ path: 'demo.proto', content: PROTO }]);
const registry = registryFromProtoText(PROTO);

function pong(text: string): string {
  const desc = registry.getMessage('demo.v1.Pong');
  if (!desc) throw new Error('missing Pong');
  return bytesToBase64(toBinary(desc, create(desc, { text })));
}

function request(overrides: Partial<GrpcRequest> = {}): GrpcRequest {
  return {
    id: 'req-1',
    name: 'Echo',
    type: 'grpc',
    methodType: 'unary',
    url: 'https://grpc.example.com',
    service: 'demo.v1.Demo',
    method: 'Echo',
    metadata: [],
    message: '{"text":"hi"}',
    auth: { type: 'none' },
    wireProtocol: 'grpc-web',
    schema: { kind: 'proto', fileName: 'demo.proto', text: PROTO },
    ...overrides,
  };
}

const end = (grpcStatus: number, extra: Record<string, unknown> = {}) => ({
  type: 'end',
  grpcStatus,
  grpcStatusText: GrpcStatusCode[grpcStatus] ?? 'UNKNOWN',
  trailers: {},
  size: 0,
  ...extra,
});

/** Serve the given lines as the relay's NDJSON body. */
function stubRelay(lines: unknown[], init: ResponseInit = {}) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
    return new Response(text, { headers: { 'content-type': 'application/x-ndjson' }, ...init });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function collect(it: AsyncIterable<GrpcWebEvent>): Promise<GrpcWebEvent[]> {
  const out: GrpcWebEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const SPEC = {
  url: 'https://grpc.example.com',
  service: 'demo.v1.Demo',
  method: 'Echo',
  message: '',
};

beforeEach(() => {
  platform.electron = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('canUseDescriptorSnapshot', () => {
  const withDescriptors = (wireProtocol?: GrpcRequest['wireProtocol']) =>
    request({ schema: { kind: 'descriptors', descriptors: DESCRIPTORS }, wireProtocol });

  it('uses reflection descriptors on the web only for gRPC-Web', () => {
    expect(canUseDescriptorSnapshot(withDescriptors('grpc-web-text'))).toBe(true);
    expect(canUseDescriptorSnapshot(withDescriptors(undefined))).toBe(false);
    expect(canUseDescriptorSnapshot(request())).toBe(false);
  });

  it('always uses them on desktop', () => {
    platform.electron = true;
    expect(canUseDescriptorSnapshot(withDescriptors(undefined))).toBe(true);
  });
});

describe('registryForGrpcWeb', () => {
  it('resolves from a persisted reflection snapshot', () => {
    const { method } = registryForGrpcWeb(
      { snapshot: { kind: 'descriptors', descriptors: DESCRIPTORS } },
      'demo.v1.Demo',
      'Watch'
    );
    expect(method.methodKind).toBe('server_streaming');
  });

  it('reports the last resolution error when every source fails', () => {
    expect(() => registryForGrpcWeb({ protoContent: PROTO }, 'demo.v1.Demo', 'Missing')).toThrow(
      /Missing/
    );
  });
});

describe('streamGrpcWebViaWorker', () => {
  it('turns a Worker validation rejection into INVALID_ARGUMENT with its message', async () => {
    stubRelay([{ error: 'Invalid URL: blocked' }], { status: 400 });
    const [ev] = await collect(streamGrpcWebViaWorker(SPEC));
    expect(ev).toMatchObject({
      type: 'end',
      grpcStatus: GrpcStatusCode.INVALID_ARGUMENT,
      grpcMessage: 'Invalid URL: blocked',
    });
  });

  it('keeps the HTTP status message for a non-JSON or error-less failure', async () => {
    stubRelay(['<html>bad gateway</html>'], { status: 502 });
    const [html] = await collect(streamGrpcWebViaWorker(SPEC));
    expect(html).toMatchObject({
      grpcStatus: GrpcStatusCode.UNAVAILABLE,
      grpcMessage: 'gRPC-Web proxy returned HTTP 502',
    });
    stubRelay([{ error: 42 }], { status: 500 });
    const [noMessage] = await collect(streamGrpcWebViaWorker(SPEC));
    expect(noMessage).toMatchObject({ grpcMessage: 'gRPC-Web proxy returned HTTP 500' });
  });

  it('ignores NDJSON values that are not events and forwards the abort signal', async () => {
    const fetchMock = stubRelay([
      42,
      'null',
      { notAnEvent: true },
      { type: 'headers', headers: { a: '1' } },
      end(0),
    ]);
    const controller = new AbortController();
    const events = await collect(streamGrpcWebViaWorker(SPEC, controller.signal));
    expect(events.map((e) => e.type)).toEqual(['headers', 'end']);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
  });
});

describe('prepareGrpcWebCall', () => {
  it('refuses secret-handle credentials on the web', () => {
    expect(() =>
      prepareGrpcWebCall(
        request({ auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'h1' } } } }),
        (s) => s,
        1000,
        {}
      )
    ).toThrow(/only available in the Restura desktop app/);
  });

  it('selects the text framing for grpc-web-text', () => {
    const { spec } = prepareGrpcWebCall(
      request({ wireProtocol: 'grpc-web-text' }),
      (s) => s,
      1000,
      {}
    );
    expect(spec.format).toBe('text');
    expect(prepareGrpcWebCall(request(), (s) => s, 1000, {}).spec.format).toBe('binary');
  });
});

describe('makeGrpcWebRequest', () => {
  it('reports INTERNAL when the relay stream ends without a status', async () => {
    stubRelay([
      { type: 'headers', headers: {} },
      { type: 'message', data: pong('a') },
    ]);
    const res = await makeGrpcWebRequest(request(), (s) => s, 1000, {});
    expect(res.grpcStatus).toBe(GrpcStatusCode.INTERNAL);
    expect(JSON.parse(res.body)).toEqual({ error: 'gRPC-Web stream ended without a status' });
  });

  it('answers an OK unary call without a message with an empty object', async () => {
    stubRelay([end(0)]);
    const res = await makeGrpcWebRequest(request(), (s) => s, 1000, {});
    expect(res.grpcStatus).toBe(GrpcStatusCode.OK);
    expect(JSON.parse(res.body)).toEqual({});
    expect(res.size).toBe(new Blob([res.body]).size);
    expect(res.messages).toBeUndefined();
  });

  it('falls back to the status name when an error carries no message', async () => {
    stubRelay([end(GrpcStatusCode.NOT_FOUND, { size: 12 })]);
    const res = await makeGrpcWebRequest(request(), (s) => s, 1000, {});
    expect(JSON.parse(res.body)).toEqual({ error: 'NOT_FOUND' });
    expect(res.size).toBe(12);
  });

  it('buffers a server stream into its messages', async () => {
    stubRelay([{ type: 'message', data: pong('a') }, { type: 'message', data: pong('b') }, end(0)]);
    const res = await makeGrpcWebRequest(request({ method: 'Watch' }), (s) => s, 1000, {});
    expect(res.messages).toEqual(['{"text":"a"}', '{"text":"b"}']);
    expect(res.isStreaming).toBe(true);
  });
});

describe('startGrpcStream over gRPC-Web', () => {
  const watch = () =>
    startGrpcStream({
      request: request({ method: 'Watch', methodType: 'server-streaming' }),
      resolveVariables: (s) => s,
      timeoutMs: 0,
    });

  it('settles done when the relay fetch fails before a terminal event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      })
    );
    const handle = await watch();
    await expect(collect(handle.messages as AsyncIterable<GrpcWebEvent>)).rejects.toThrow(
      'network down'
    );
    await expect(handle.done).resolves.toMatchObject({
      status: GrpcStatusCode.UNKNOWN,
      statusMessage: 'network down',
    });
  });

  it('settles done when a streamed message fails to decode', async () => {
    stubRelay([
      { type: 'headers', headers: { a: '1' } },
      { type: 'message', data: '/w==' },
    ]);
    const handle = await watch();
    await expect(collect(handle.messages as AsyncIterable<GrpcWebEvent>)).rejects.toThrow();
    await expect(handle.done).resolves.toMatchObject({ headers: { a: '1' } });
  });

  it('forwards a "No deadline" stream as timeout 0', async () => {
    const fetchMock = stubRelay([end(0)]);
    const handle = await watch();
    await collect(handle.messages as AsyncIterable<GrpcWebEvent>);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.timeout).toBe(0);
    await expect(handle.done).resolves.toMatchObject({ status: GrpcStatusCode.OK });
  });
});
