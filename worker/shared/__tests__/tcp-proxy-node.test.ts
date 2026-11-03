// @vitest-environment node

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal fake socket — `onWrite` lets each test reply to the production
// code's write() so the response is only emitted AFTER the production code
// has finished writing AND (importantly) had a chance to attach its 'data'
// listener. Pre-emitted data on an EventEmitter is lost.
class FakeSocket extends EventEmitter {
  written: Buffer[] = [];
  destroyed = false;
  onWrite: ((sock: FakeSocket) => void) | null = null;
  write(data: Buffer | Uint8Array): boolean {
    this.written.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    if (this.onWrite) queueMicrotask(() => this.onWrite!(this));
    return true;
  }
  destroy(): void {
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
  }
  unshift(_chunk: Buffer): void {
    /* no-op for these tests */
  }
}

const state = {
  nextNetSocket: null as FakeSocket | null,
  nextTlsSocket: null as FakeSocket | null,
  /** When set, the fake TLS handshake fails with this error instead of connecting. */
  tlsError: null as Error | null,
};

vi.mock('node:dns/promises', () => {
  const lookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  return { lookup, default: { lookup } };
});

vi.mock('node:net', () => {
  const connect = vi.fn(() => {
    const sock = state.nextNetSocket;
    if (!sock) throw new Error('test forgot to seed nextNetSocket');
    queueMicrotask(() => sock.emit('connect'));
    return sock;
  });
  const isIP = (s: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : 0);
  return { connect, isIP, default: { connect, isIP } };
});

vi.mock('node:tls', () => {
  const connect = vi.fn(() => {
    const sock = state.nextTlsSocket;
    if (!sock) throw new Error('test forgot to seed nextTlsSocket');
    const tlsError = state.tlsError;
    queueMicrotask(() => (tlsError ? sock.emit('error', tlsError) : sock.emit('secureConnect')));
    return sock;
  });
  return { connect, default: { connect } };
});

import { createHttpsViaConnectProxy, createHttpViaProxy } from '../tcp-proxy-node';

beforeEach(() => {
  state.nextNetSocket = null;
  state.nextTlsSocket = null;
  state.tlsError = null;
});

describe('httpsViaConnectProxy — CONNECT response handling (Fix #2)', () => {
  it('does NOT hang when the CONNECT 200 response has no Content-Length', async () => {
    const proxySock = new FakeSocket();
    const tlsSock = new FakeSocket();
    state.nextNetSocket = proxySock;
    state.nextTlsSocket = tlsSock;

    // Step 1: production code writes the CONNECT request → reply with a
    // bodyless 200 (the bug was hanging here forever waiting for Content-
    // Length). The proxy socket isn't written to again after this; subsequent
    // bytes go to the TLS socket.
    proxySock.onWrite = (s) => {
      s.emit('data', Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n'));
    };
    // Step 2: production code writes the tunnelled request → reply 204.
    tlsSock.onWrite = (s) => {
      s.emit('data', Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'));
    };

    const ac = new AbortController();
    const safety = setTimeout(() => ac.abort(), 2000);
    const httpsViaConnectProxy = createHttpsViaConnectProxy({ allowPrivateIPs: false });
    const res = await httpsViaConnectProxy(
      new URL('https://example.com/'),
      { host: 'proxy.example', port: 8080 },
      { method: 'GET' },
      ac.signal
    );
    clearTimeout(safety);
    expect(res.status).toBe(200);
  });

  it('rejects a non-200 CONNECT response (exact status-code match, not substring)', async () => {
    const proxySock = new FakeSocket();
    state.nextNetSocket = proxySock;
    // 502 with reason phrase containing '200' — substring-match would falsely
    // accept this; exact match rejects it.
    proxySock.onWrite = (s) => {
      s.emit('data', Buffer.from('HTTP/1.1 502 Backend 200 unavailable\r\n\r\n'));
    };

    const httpsViaConnectProxy = createHttpsViaConnectProxy({ allowPrivateIPs: false });
    await expect(
      httpsViaConnectProxy(
        new URL('https://example.com/'),
        { host: 'proxy.example', port: 8080 },
        { method: 'GET' },
        new AbortController().signal
      )
    ).rejects.toThrow(/Proxy CONNECT failed/);
  });
});

describe('extension methods go out verbatim through the upstream proxy (#857)', () => {
  it('httpViaProxy writes a mixed-case extension method unchanged', async () => {
    const sock = new FakeSocket();
    state.nextNetSocket = sock;
    sock.onWrite = (s) => {
      s.emit('data', Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'));
    };
    await createHttpViaProxy({ allowPrivateIPs: false })(
      new URL('http://example.com/x'),
      { host: 'proxy.example', port: 8080 },
      { method: 'propFind' },
      new AbortController().signal
    );
    expect(Buffer.concat(sock.written).toString('utf-8')).toMatch(
      /^propFind http:\/\/example\.com\/x HTTP\/1\.1\r\n/
    );
  });

  it('httpsViaConnectProxy writes a mixed-case extension method unchanged', async () => {
    const proxySock = new FakeSocket();
    const tlsSock = new FakeSocket();
    state.nextNetSocket = proxySock;
    state.nextTlsSocket = tlsSock;
    proxySock.onWrite = (s) => {
      s.emit('data', Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n'));
    };
    tlsSock.onWrite = (s) => {
      s.emit('data', Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'));
    };
    await createHttpsViaConnectProxy({ allowPrivateIPs: false })(
      new URL('https://example.com/x'),
      { host: 'proxy.example', port: 8080 },
      { method: 'customVerb' },
      new AbortController().signal
    );
    expect(Buffer.concat(tlsSock.written).toString('utf-8')).toMatch(
      /^customVerb \/x HTTP\/1\.1\r\n/
    );
  });
});

describe('Headers normalisation (Fix #10)', () => {
  it('preserves headers passed as a Headers instance through httpViaProxy', async () => {
    const sock = new FakeSocket();
    state.nextNetSocket = sock;
    sock.onWrite = (s) => {
      s.emit('data', Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'));
    };

    const headers = new Headers({ 'X-Custom-Header': 'preserved', Authorization: 'Bearer xyz' });
    const httpViaProxy = createHttpViaProxy({ allowPrivateIPs: false });
    await httpViaProxy(
      new URL('http://example.com/'),
      { host: 'proxy.example', port: 8080 },
      { method: 'GET', headers },
      new AbortController().signal
    );

    // The Headers constructor lowercases header names; we just need the
    // values to survive the Object.entries → toRecord path. (The bug was
    // Object.entries(Headers) yielding []; the values would be missing
    // entirely, not just case-shifted.)
    const wire = Buffer.concat(sock.written).toString('utf-8').toLowerCase();
    expect(wire).toContain('x-custom-header: preserved');
    expect(wire).toContain('authorization: bearer xyz');
  });
});

describe('response header parsing keeps repeated Set-Cookie fields (#855)', () => {
  it('httpViaProxy surfaces each Set-Cookie via Headers.getSetCookie()', async () => {
    const sock = new FakeSocket();
    state.nextNetSocket = sock;
    sock.onWrite = (s) => {
      s.emit(
        'data',
        Buffer.from(
          'HTTP/1.1 200 OK\r\n' +
            'Set-Cookie: session=abc; Path=/\r\n' +
            'Set-Cookie: csrf=xyz; Expires=Wed, 21 Oct 2026 07:28:00 GMT\r\n' +
            'Set-Cookie: pref=dark\r\n' +
            'Content-Length: 0\r\n\r\n'
        )
      );
    };

    const httpViaProxy = createHttpViaProxy({ allowPrivateIPs: false });
    const res = await httpViaProxy(
      new URL('http://example.com/'),
      { host: 'proxy.example', port: 8080 },
      { method: 'GET' },
      new AbortController().signal
    );
    expect(res.headers.getSetCookie()).toEqual([
      'session=abc; Path=/',
      'csrf=xyz; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
      'pref=dark',
    ]);
  });
});

/** Seed a CONNECT tunnel whose proxy answers 200. */
function seedTunnel(): { proxySock: FakeSocket; tlsSock: FakeSocket } {
  const proxySock = new FakeSocket();
  const tlsSock = new FakeSocket();
  state.nextNetSocket = proxySock;
  state.nextTlsSocket = tlsSock;
  proxySock.onWrite = (s) => {
    s.emit('data', Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n'));
  };
  return { proxySock, tlsSock };
}

const replyEmpty200 = (s: FakeSocket) => {
  s.emit('data', Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'));
};

describe('tunnelled request framing (parity with tcp-proxy.ts)', () => {
  it('httpsViaConnectProxy sends exactly one Host header (the target authority)', async () => {
    const { tlsSock } = seedTunnel();
    tlsSock.onWrite = replyEmpty200;
    await createHttpsViaConnectProxy({ allowPrivateIPs: false })(
      new URL('https://example.com:8443/x'),
      { host: 'proxy.example', port: 8080 },
      { method: 'GET', headers: { host: 'stale.example', Accept: '*/*' } },
      new AbortController().signal
    );
    const hosts = Buffer.concat(tlsSock.written)
      .toString('utf-8')
      .match(/^host:[^\r\n]*/gim);
    expect(hosts).toEqual(['Host: example.com:8443']);
  });

  it('httpsViaConnectProxy forwards a binary (Uint8Array) body with a byte Content-Length', async () => {
    const { tlsSock } = seedTunnel();
    tlsSock.onWrite = replyEmpty200;
    await createHttpsViaConnectProxy({ allowPrivateIPs: false })(
      new URL('https://example.com/upload'),
      { host: 'proxy.example', port: 8080 },
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array([0x00, 0xff, 0x10, 0x80]),
      },
      new AbortController().signal
    );
    const all = Buffer.concat(tlsSock.written);
    expect(Array.from(all.subarray(-4))).toEqual([0x00, 0xff, 0x10, 0x80]);
    expect(all.toString('latin1')).toMatch(/\r\nContent-Length: 4\r\n/);
  });

  it('httpViaProxy forwards a FormData body as multipart with its boundary Content-Type', async () => {
    const sock = new FakeSocket();
    state.nextNetSocket = sock;
    sock.onWrite = replyEmpty200;
    const fd = new FormData();
    fd.append('field', 'value-123');
    await createHttpViaProxy({ allowPrivateIPs: false })(
      new URL('http://example.com/form'),
      { host: 'proxy.example', port: 8080 },
      { method: 'POST', body: fd },
      new AbortController().signal
    );
    const text = Buffer.concat(sock.written).toString('utf-8');
    expect(text).toMatch(/\r\nContent-Type: multipart\/form-data; boundary=[^\r]+\r\n/i);
    const split = text.indexOf('\r\n\r\n');
    const body = text.slice(split + 4);
    expect(body).toContain('value-123');
    expect(text.slice(0, split)).toContain(`\r\nContent-Length: ${Buffer.byteLength(body)}`);
  });

  it('returns a 204 without throwing on the null-body Response', async () => {
    const sock = new FakeSocket();
    state.nextNetSocket = sock;
    sock.onWrite = (s) => {
      s.emit('data', Buffer.from('HTTP/1.1 204 No Content\r\n\r\n'));
    };
    const res = await createHttpViaProxy({ allowPrivateIPs: false })(
      new URL('http://example.com/'),
      { host: 'proxy.example', port: 8080 },
      { method: 'DELETE' },
      new AbortController().signal
    );
    expect(res.status).toBe(204);
  });
});

describe('httpsViaConnectProxy — proxy socket is destroyed on every failure path', () => {
  it('destroys the proxy socket when the CONNECT reply never completes', async () => {
    const proxySock = new FakeSocket();
    state.nextNetSocket = proxySock;
    proxySock.onWrite = (s) => s.emit('end');
    await expect(
      createHttpsViaConnectProxy({ allowPrivateIPs: false })(
        new URL('https://example.com/'),
        { host: 'proxy.example', port: 8080 },
        { method: 'GET' },
        new AbortController().signal
      )
    ).rejects.toThrow(/closed before CONNECT/);
    expect(proxySock.destroyed).toBe(true);
  });

  it('destroys the proxy socket when the TLS upgrade fails', async () => {
    const { proxySock, tlsSock } = seedTunnel();
    state.tlsError = new Error('certificate has expired');
    await expect(
      createHttpsViaConnectProxy({ allowPrivateIPs: false })(
        new URL('https://example.com/'),
        { host: 'proxy.example', port: 8080 },
        { method: 'GET' },
        new AbortController().signal
      )
    ).rejects.toThrow(/certificate has expired/);
    expect(tlsSock.written).toEqual([]);
    expect(proxySock.destroyed).toBe(true);
  });
});

describe('response framing parity with the Cloudflare twin', () => {
  const viaHttp = (init: RequestInit = { method: 'GET' }) =>
    createHttpViaProxy({ allowPrivateIPs: false })(
      new URL('http://example.com/'),
      { host: 'proxy.example', port: 8080 },
      init,
      new AbortController().signal
    );

  it('rejects when the upstream ends before Content-Length bytes arrived', async () => {
    const sock = new FakeSocket();
    state.nextNetSocket = sock;
    sock.onWrite = (s) => {
      s.emit('data', Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc'));
      s.emit('end');
    };
    await expect(viaHttp()).rejects.toThrow(/3 of 10 body bytes/);
  });

  it('skips 1xx interim heads and returns the final response', async () => {
    const sock = new FakeSocket();
    state.nextNetSocket = sock;
    sock.onWrite = (s) => {
      s.emit('data', Buffer.from('HTTP/1.1 100 Continue\r\n\r\n'));
      s.emit('data', Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'));
    };
    const res = await viaHttp({ method: 'POST', body: 'x' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('refuses a header that would inject a line onto the proxy socket, writing nothing', async () => {
    const sock = new FakeSocket();
    state.nextNetSocket = sock;
    sock.onWrite = (s) =>
      s.emit('data', Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'));
    await expect(
      viaHttp({ method: 'GET', headers: { 'X-A': 'v\r\nX-Injected: 1' } })
    ).rejects.toThrow(/Invalid request header/);
    expect(sock.written).toEqual([]);
    expect(sock.destroyed).toBe(true);
  });
});
