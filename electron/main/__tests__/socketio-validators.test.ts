import { describe, expect, it } from 'vitest';
import {
  SocketIoConnectSchema,
  SocketIoDisconnectSchema,
  SocketIoEmitSchema,
} from '../ipc/ipc-validators';

describe('SocketIoConnectSchema', () => {
  it('accepts a minimal http(s) URL', () => {
    const result = SocketIoConnectSchema.safeParse({
      connectionId: 'conn-1',
      url: 'https://example.com',
    });
    expect(result.success).toBe(true);
  });

  it('accepts ws(s) URLs', () => {
    for (const url of ['ws://example.com', 'wss://example.com']) {
      expect(SocketIoConnectSchema.safeParse({ connectionId: 'c', url }).success).toBe(true);
    }
  });

  it('rejects unsupported protocols', () => {
    expect(
      SocketIoConnectSchema.safeParse({ connectionId: 'c', url: 'ftp://example.com' }).success
    ).toBe(false);
    expect(
      SocketIoConnectSchema.safeParse({ connectionId: 'c', url: 'file:///etc/passwd' }).success
    ).toBe(false);
  });

  it('rejects invalid connection IDs', () => {
    expect(
      SocketIoConnectSchema.safeParse({
        connectionId: 'has spaces!',
        url: 'https://example.com',
      }).success
    ).toBe(false);
  });

  it('rejects denylisted extraHeaders (host, origin, sec-websocket-*)', () => {
    for (const header of ['Host', 'origin', 'Sec-WebSocket-Key', 'Upgrade', 'transfer-encoding']) {
      const result = SocketIoConnectSchema.safeParse({
        connectionId: 'c',
        url: 'https://example.com',
        extraHeaders: { [header]: 'evil.com' },
      });
      expect(result.success, `header ${header} should be rejected`).toBe(false);
    }
  });

  it('accepts safe custom extraHeaders', () => {
    const result = SocketIoConnectSchema.safeParse({
      connectionId: 'c',
      url: 'https://example.com',
      extraHeaders: { 'X-Tenant': 'acme', Authorization: 'Bearer x' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects namespace with shell-unsafe characters', () => {
    expect(
      SocketIoConnectSchema.safeParse({
        connectionId: 'c',
        url: 'https://example.com',
        namespace: '/chat;rm -rf /',
      }).success
    ).toBe(false);
  });

  it('accepts safe namespaces', () => {
    for (const ns of ['/', '/chat', '/admin/v1', '/foo_bar']) {
      expect(
        SocketIoConnectSchema.safeParse({
          connectionId: 'c',
          url: 'https://example.com',
          namespace: ns,
        }).success,
        `namespace ${ns}`
      ).toBe(true);
    }
  });

  it('rejects path that does not start with /', () => {
    expect(
      SocketIoConnectSchema.safeParse({
        connectionId: 'c',
        url: 'https://example.com',
        path: 'socket.io',
      }).success
    ).toBe(false);
  });

  it('accepts the full option payload', () => {
    const result = SocketIoConnectSchema.safeParse({
      connectionId: 'c',
      url: 'https://example.com',
      namespace: '/chat',
      path: '/socket.io',
      auth: { token: 'abc', userId: 1, isAdmin: true },
      query: { room: 'lobby' },
      extraHeaders: { 'X-Tenant': 'acme' },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      timeout: 20_000,
      forceNew: false,
    });
    expect(result.success).toBe(true);
  });
});

describe('SocketIoEmitSchema', () => {
  it('accepts a simple emit', () => {
    expect(
      SocketIoEmitSchema.safeParse({
        connectionId: 'c',
        eventName: 'message',
        args: ['hello'],
      }).success
    ).toBe(true);
  });

  it('accepts an emit with ack', () => {
    expect(
      SocketIoEmitSchema.safeParse({
        connectionId: 'c',
        eventName: 'rpc',
        args: [{ method: 'add', params: [1, 2] }],
        ackId: 'ack-1',
        ackTimeoutMs: 5000,
      }).success
    ).toBe(true);
  });

  it('rejects empty event name', () => {
    expect(
      SocketIoEmitSchema.safeParse({ connectionId: 'c', eventName: '', args: [] }).success
    ).toBe(false);
  });

  it('rejects more than 32 args', () => {
    const args = new Array(33).fill(0);
    expect(SocketIoEmitSchema.safeParse({ connectionId: 'c', eventName: 'x', args }).success).toBe(
      false
    );
  });

  it('rejects ackTimeoutMs above 60s', () => {
    expect(
      SocketIoEmitSchema.safeParse({
        connectionId: 'c',
        eventName: 'x',
        args: [],
        ackId: 'a',
        ackTimeoutMs: 60_001,
      }).success
    ).toBe(false);
  });
});

describe('SocketIoDisconnectSchema', () => {
  it('accepts a valid connection ID', () => {
    expect(SocketIoDisconnectSchema.safeParse({ connectionId: 'abc-123' }).success).toBe(true);
  });

  it('rejects missing or invalid connection ID', () => {
    expect(SocketIoDisconnectSchema.safeParse({}).success).toBe(false);
    expect(SocketIoDisconnectSchema.safeParse({ connectionId: 'has spaces' }).success).toBe(false);
  });
});
