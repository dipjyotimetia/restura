// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fake `cloudflare:sockets` Socket: `push`/`end` drive the readable side, and
// `onWrite` lets a test reply only after the production code has written (so
// the reader is attached before bytes arrive). Each push is a separate chunk,
// which is the point — headers and body arriving in separate reads.
interface FakeCfSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  written: Uint8Array[];
  closed: boolean;
  closeCount: number;
  onWrite: ((s: FakeCfSocket) => void) | null;
  tls: FakeCfSocket | null;
  push(chunk: string): void;
  end(): void;
  startTls(): FakeCfSocket;
  close(): Promise<void>;
}

const ENC = new TextEncoder();
const DEC = new TextDecoder();

function fakeSocket(): FakeCfSocket {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const sock: FakeCfSocket = {
    readable: new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        sock.written.push(chunk);
        const reply = sock.onWrite;
        if (reply) queueMicrotask(() => reply(sock));
      },
    }),
    written: [],
    closed: false,
    closeCount: 0,
    onWrite: null,
    tls: null,
    push(chunk) {
      controller?.enqueue(ENC.encode(chunk));
    },
    end() {
      controller?.close();
    },
    startTls() {
      if (!sock.tls) throw new Error('test forgot to seed tls socket');
      return sock.tls;
    },
    async close() {
      sock.closed = true;
      sock.closeCount += 1;
    },
  };
  return sock;
}

const state = { next: null as FakeCfSocket | null };

vi.mock('cloudflare:sockets', () => ({
  connect: vi.fn(() => {
    if (!state.next) throw new Error('test forgot to seed socket');
    return state.next;
  }),
}));

// A small response cap so the too-large paths are cheap to reach.
const MAX = 1024;
vi.mock('@shared/protocol/http-proxy', () => ({ MAX_RESPONSE_SIZE: 1024 }));

import { httpsViaConnectProxy, httpViaProxy } from '../tcp-proxy';

const PROXY = { host: 'proxy.example', port: 8080 };
const wire = (s: FakeCfSocket): string => s.written.map((c) => DEC.decode(c)).join('');

beforeEach(() => {
  state.next = null;
});

/** Seed a CONNECT tunnel: the proxy answers 200 and keeps the socket open. */
function seedTunnel(): FakeCfSocket {
  const proxySock = fakeSocket();
  const tlsSock = fakeSocket();
  proxySock.tls = tlsSock;
  proxySock.onWrite = (s) => s.push('HTTP/1.1 200 Connection established\r\n\r\n');
  state.next = proxySock;
  return tlsSock;
}

describe('readHttpResponse — bodies without Content-Length are read to EOF', () => {
  it('httpViaProxy keeps a connection-close body that arrives after the headers', async () => {
    const sock = fakeSocket();
    state.next = sock;
    sock.onWrite = (s) => {
      s.push('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n');
      s.push('hello ');
      s.push('world');
      s.end();
    };
    const res = await httpViaProxy(
      new URL('http://example.com/'),
      PROXY,
      { method: 'GET' },
      new AbortController().signal
    );
    expect(await res.text()).toBe('hello world');
  });

  it('passes chunked framing through raw, like the Node twin', async () => {
    const tlsSock = seedTunnel();
    tlsSock.onWrite = (s) => {
      s.push('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n');
      s.push('5\r\nhello\r\n');
      s.push('0\r\n\r\n');
      s.end();
    };
    const res = await httpsViaConnectProxy(
      new URL('https://example.com/'),
      PROXY,
      { method: 'GET' },
      new AbortController().signal
    );
    expect(await res.text()).toBe('5\r\nhello\r\n0\r\n\r\n');
  });

  it('does not wait for EOF on a bodyless 204', async () => {
    const sock = fakeSocket();
    state.next = sock;
    sock.onWrite = (s) => s.push('HTTP/1.1 204 No Content\r\n\r\n');
    const res = await httpViaProxy(
      new URL('http://example.com/'),
      PROXY,
      { method: 'GET' },
      new AbortController().signal
    );
    expect(res.status).toBe(204);
  });

  it('still stops at Content-Length without waiting for EOF', async () => {
    const sock = fakeSocket();
    state.next = sock;
    sock.onWrite = (s) => {
      s.push('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n');
      s.push('ok');
    };
    const res = await httpViaProxy(
      new URL('http://example.com/'),
      PROXY,
      { method: 'GET' },
      new AbortController().signal
    );
    expect(await res.text()).toBe('ok');
  });
});

describe('httpsViaConnectProxy — tunnelled request framing', () => {
  it('sends exactly one Host header (the target authority)', async () => {
    const tlsSock = seedTunnel();
    tlsSock.onWrite = (s) => s.push('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    await httpsViaConnectProxy(
      new URL('https://example.com:8443/x'),
      PROXY,
      { method: 'GET', headers: { host: 'stale.example', Accept: '*/*' } },
      new AbortController().signal
    );
    const hosts = wire(tlsSock).match(/^host:[^\r\n]*/gim);
    expect(hosts).toEqual(['Host: example.com:8443']);
  });

  it('forwards a binary (Uint8Array) body with a byte Content-Length', async () => {
    const tlsSock = seedTunnel();
    tlsSock.onWrite = (s) => s.push('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    const body = new Uint8Array([0x00, 0xff, 0x10, 0x80]);
    await httpsViaConnectProxy(
      new URL('https://example.com/upload'),
      PROXY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
      },
      new AbortController().signal
    );
    const all = new Uint8Array(tlsSock.written.reduce((n, c) => n + c.byteLength, 0));
    let off = 0;
    for (const c of tlsSock.written) {
      all.set(c, off);
      off += c.byteLength;
    }
    expect(Array.from(all.slice(-4))).toEqual([0x00, 0xff, 0x10, 0x80]);
    expect(wire(tlsSock)).toMatch(/\r\nContent-Length: 4\r\n/);
  });

  it('forwards a FormData body as multipart with its boundary Content-Type', async () => {
    const sock = fakeSocket();
    state.next = sock;
    sock.onWrite = (s) => s.push('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    const fd = new FormData();
    fd.append('field', 'value-123');
    await httpViaProxy(
      new URL('http://example.com/form'),
      PROXY,
      { method: 'POST', body: fd },
      new AbortController().signal
    );
    const text = wire(sock);
    const boundary = /\r\nContent-Type: multipart\/form-data; boundary=([^\r]+)\r\n/i.exec(
      text
    )?.[1];
    expect(boundary).toBeTruthy();
    expect(text).toContain('value-123');
    const split = text.indexOf('\r\n\r\n');
    const head = text.slice(0, split);
    const body = text.slice(split + 4);
    expect(head).toMatch(new RegExp(`\\r\\nContent-Length: ${ENC.encode(body).byteLength}(\\r|$)`));
  });
});

describe('socket cleanup on every failure path (Node twin parity)', () => {
  const signal = () => new AbortController().signal;
  const https = () =>
    httpsViaConnectProxy(new URL('https://example.com/'), PROXY, { method: 'GET' }, signal());
  const http = () =>
    httpViaProxy(new URL('http://example.com/'), PROXY, { method: 'GET' }, signal());

  it('closes the proxy socket once when it hangs up before the CONNECT reply', async () => {
    const sock = fakeSocket();
    state.next = sock;
    sock.onWrite = (s) => s.end();
    await expect(https()).rejects.toThrow('closed before CONNECT response headers');
    expect(sock.closeCount).toBe(1);
  });

  it('closes the proxy socket once when the CONNECT reply is too large', async () => {
    const sock = fakeSocket();
    state.next = sock;
    sock.onWrite = (s) => s.push(`HTTP/1.1 200 OK\r\nX-Pad: ${'a'.repeat(MAX)}`);
    await expect(https()).rejects.toThrow('Response too large');
    expect(sock.closeCount).toBe(1);
  });

  it('closes the proxy socket once when the TLS upgrade throws', async () => {
    const sock = fakeSocket();
    state.next = sock;
    sock.onWrite = (s) => s.push('HTTP/1.1 200 Connection established\r\n\r\n');
    await expect(https()).rejects.toThrow('test forgot to seed tls socket');
    expect(sock.closeCount).toBe(1);
  });

  it('still closes once on a non-200 CONNECT reply', async () => {
    const sock = fakeSocket();
    state.next = sock;
    sock.onWrite = (s) => s.push('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
    await expect(https()).rejects.toThrow('Proxy CONNECT failed');
    expect(sock.closeCount).toBe(1);
  });

  it('httpViaProxy closes the socket once when the response is too large', async () => {
    const sock = fakeSocket();
    state.next = sock;
    sock.onWrite = (s) => s.push(`HTTP/1.1 200 OK\r\n\r\n${'b'.repeat(MAX)}`);
    await expect(http()).rejects.toThrow('Response too large');
    expect(sock.closeCount).toBe(1);
  });

  it('httpViaProxy closes the socket once when upstream ends before the headers', async () => {
    const sock = fakeSocket();
    state.next = sock;
    sock.onWrite = (s) => {
      s.push('HTTP/1.1 200 OK\r\n');
      s.end();
    };
    await expect(http()).rejects.toThrow('Upstream closed before response headers');
    expect(sock.closeCount).toBe(1);
  });

  it('httpViaProxy closes the socket once on success', async () => {
    const sock = fakeSocket();
    state.next = sock;
    sock.onWrite = (s) => s.push('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
    expect(await (await http()).text()).toBe('ok');
    expect(sock.closeCount).toBe(1);
  });
});
