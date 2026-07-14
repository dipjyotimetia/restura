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
    queueMicrotask(() => sock.emit('secureConnect'));
    return sock;
  });
  return { connect, default: { connect } };
});

import { createHttpsViaConnectProxy, createHttpViaProxy } from '../tcp-proxy-node';

beforeEach(() => {
  state.nextNetSocket = null;
  state.nextTlsSocket = null;
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
