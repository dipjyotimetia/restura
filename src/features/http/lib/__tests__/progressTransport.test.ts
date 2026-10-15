import {
  encodeSetCookieSideChannel,
  SET_COOKIE_SIDE_CHANNEL_HEADER,
} from '@shared/protocol/set-cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const isElectronMock = vi.hoisted(() => vi.fn(() => false));
const bufferedMock = vi.hoisted(() => vi.fn());
const streamingMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/shared/platform', () => ({ isElectron: isElectronMock }));
vi.mock('@/lib/shared/transport', () => ({
  executeProxiedRequest: bufferedMock,
  executeProxiedStreamingRequest: streamingMock,
  ProxyTransportError: class ProxyTransportError extends Error {
    readonly status: number | undefined;
    constructor(message: string, status?: number) {
      super(message);
      this.name = 'ProxyTransportError';
      this.status = status;
    }
  },
}));

import { executeProxiedRequestWithProgress } from '../progressTransport';

const SPEC = { method: 'POST', url: 'https://api.example.test/graphql' } as never;
const enc = (s: string) => new TextEncoder().encode(s);

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc(c));
      controller.close();
    },
  });
}

function upstream(chunks: string[], headers: Record<string, string>): Response {
  return new Response(streamOf(chunks), {
    status: 200,
    statusText: 'OK',
    headers: { ...headers, 'x-restura-proxy-stream': '1' },
  });
}

describe('executeProxiedRequestWithProgress — web', () => {
  beforeEach(() => {
    isElectronMock.mockReturnValue(false);
    streamingMock.mockReset();
    bufferedMock.mockReset();
  });

  it('streams via the Worker pass-through, reports each chunk and resolves the buffered shape', async () => {
    streamingMock.mockResolvedValue(
      upstream(['{"a":', '1}'], {
        'content-type': 'application/json',
        [SET_COOKIE_SIDE_CHANNEL_HEADER]: encodeSetCookieSideChannel(['s=1; Path=/']),
      })
    );
    const seen: string[] = [];
    const out = await executeProxiedRequestWithProgress(SPEC, (p) => {
      seen.push(new TextDecoder().decode(p.chunk));
      expect(p.status).toBe(200);
      expect(p.headers['content-type']).toBe('application/json');
    });

    expect(streamingMock.mock.calls[0]![0]).toMatchObject({ streamingMode: true });
    expect(seen).toEqual(['{"a":', '1}']);
    expect(out).toMatchObject({
      status: 200,
      data: '{"a":1}',
      size: 7,
      setCookies: ['s=1; Path=/'],
    });
    expect(out.headers).not.toHaveProperty('x-restura-proxy-stream');
    expect(out.headers).not.toHaveProperty(SET_COOKIE_SIDE_CHANNEL_HEADER);
    expect(out.bodyEncoding).toBeUndefined();
  });

  it('base64-encodes binary content types, like the buffered Worker reply', async () => {
    streamingMock.mockResolvedValue(
      upstream(['--b\r\n\r\n{}\r\n--b--'], { 'content-type': 'multipart/mixed; boundary=b' })
    );
    const out = await executeProxiedRequestWithProgress(SPEC, () => undefined);
    expect(out.bodyEncoding).toBe('base64');
    expect(atob(out.data as string)).toBe('--b\r\n\r\n{}\r\n--b--');
  });

  it('turns an unmarked reply (the proxy’s own JSON error) into a ProxyTransportError', async () => {
    streamingMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Blocked private address' }), { status: 400 })
    );
    await expect(executeProxiedRequestWithProgress(SPEC, () => undefined)).rejects.toMatchObject({
      name: 'ProxyTransportError',
      message: 'Blocked private address',
      status: 400,
    });

    streamingMock.mockResolvedValue(new Response(JSON.stringify({ error: 42 }), { status: 401 }));
    const out = await executeProxiedRequestWithProgress(SPEC, () => undefined);
    // `{ error }` that isn't a string isn't a proxy error envelope.
    expect(out.status).toBe(401);
  });

  it('treats unmarked 2xx or non-envelope replies as upstream (older Worker, version skew)', async () => {
    streamingMock.mockResolvedValueOnce(
      new Response('{"data":{"a":1}}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const progress = vi.fn();
    const ok = await executeProxiedRequestWithProgress(SPEC, progress);
    expect(ok).toMatchObject({ status: 200, data: '{"data":{"a":1}}' });
    expect(progress).toHaveBeenCalled();

    streamingMock.mockResolvedValueOnce(new Response('upstream says no', { status: 503 }));
    const err = await executeProxiedRequestWithProgress(SPEC, () => undefined);
    expect(err).toMatchObject({ status: 503, data: 'upstream says no' });
  });

  it('wraps network failures but lets aborts through untouched', async () => {
    streamingMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(executeProxiedRequestWithProgress(SPEC, () => undefined)).rejects.toMatchObject({
      name: 'ProxyTransportError',
      message: 'Failed to fetch',
    });
    streamingMock.mockRejectedValueOnce('boom');
    await expect(executeProxiedRequestWithProgress(SPEC, () => undefined)).rejects.toMatchObject({
      message: 'Proxy request failed',
    });
    const abort = new DOMException('aborted', 'AbortError');
    streamingMock.mockRejectedValueOnce(abort);
    await expect(executeProxiedRequestWithProgress(SPEC, () => undefined)).rejects.toBe(abort);
  });

  it('caps the streamed body at the proxy response limit', async () => {
    const big = 'x'.repeat(6 * 1024 * 1024);
    streamingMock.mockResolvedValue(upstream([big, big], { 'content-type': 'text/plain' }));
    await expect(executeProxiedRequestWithProgress(SPEC, () => undefined)).rejects.toMatchObject({
      status: 413,
    });
  });

  it('cancels the upstream body when the read loop throws', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc('a'));
      },
      cancel,
    });
    streamingMock.mockResolvedValue(
      new Response(body, { status: 200, headers: { 'x-restura-proxy-stream': '1' } })
    );
    await expect(
      executeProxiedRequestWithProgress(SPEC, () => {
        throw new Error('sink failed');
      })
    ).rejects.toThrow('sink failed');
    expect(cancel).toHaveBeenCalled();
  });

  it('handles a reply with no body', async () => {
    streamingMock.mockResolvedValue(
      new Response(null, { status: 204, headers: { 'x-restura-proxy-stream': '1' } })
    );
    const progress = vi.fn();
    const out = await executeProxiedRequestWithProgress(SPEC, progress);
    expect(out).toMatchObject({ status: 204, data: '', size: 0 });
    expect(progress).not.toHaveBeenCalled();
  });
});

describe('executeProxiedRequestWithProgress — desktop fallback', () => {
  beforeEach(() => {
    isElectronMock.mockReturnValue(true);
    bufferedMock.mockReset();
  });

  it('uses the buffered IPC call and reports the decoded body once', async () => {
    bufferedMock.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': ['multipart/mixed; boundary=b'] },
      data: btoa('hello'),
      bodyEncoding: 'base64',
    });
    const progress = vi.fn();
    const signal = new AbortController().signal;
    const desktop = { verifySsl: false } as never;
    const out = await executeProxiedRequestWithProgress(SPEC, progress, { signal }, desktop);
    expect(bufferedMock).toHaveBeenCalledWith(SPEC, { signal }, desktop);
    expect(out.data).toBe(btoa('hello'));
    expect(progress).toHaveBeenCalledOnce();
    const p = progress.mock.calls[0]![0];
    expect(new TextDecoder().decode(p.chunk)).toBe('hello');
    expect(p.headers['content-type']).toBe('multipart/mixed; boundary=b');
  });

  it('reports a text body (and tolerates a non-string body)', async () => {
    bufferedMock.mockResolvedValueOnce({ status: 200, statusText: 'OK', headers: {}, data: 'hi' });
    const progress = vi.fn();
    await executeProxiedRequestWithProgress(SPEC, progress);
    expect(new TextDecoder().decode(progress.mock.calls[0]![0].chunk)).toBe('hi');

    bufferedMock.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: { a: 1 },
    });
    await executeProxiedRequestWithProgress(SPEC, progress);
    expect(progress.mock.calls[1]![0].chunk.byteLength).toBe(0);
  });
});
