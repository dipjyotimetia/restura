import { parse } from 'engine.io-client';
import { describe, expect, it } from 'vitest';
import { socketIoConnectUrl } from './socketio-url';

// The parser io() uses for the URL it is given (engine.io-client's parseuri).
const ioHost = (url: string) => parse(url).host;

describe('socketIoConnectUrl', () => {
  it.each([
    'http://example.com\\@127.0.0.1:3000/',
    'ws://example.com\\@localhost/socket',
    'https://user:pass@example.com\\@127.0.0.1/',
    'http://example.com\t/\\@127.0.0.1/',
  ])('io() reads the same host the WHATWG guard checked: %s', (raw) => {
    const guarded = new URL(raw).hostname;
    expect(ioHost(socketIoConnectUrl(raw, undefined))).toBe(guarded);
    expect(ioHost(socketIoConnectUrl(raw, '/chat'))).toBe(guarded);
  });

  it('keeps the host when the namespace looks like an authority', () => {
    for (const ns of ['//127.0.0.1', '\\\\127.0.0.1', '/\\@127.0.0.1', '@127.0.0.1']) {
      expect(ioHost(socketIoConnectUrl('https://example.com', ns))).toBe('example.com');
    }
  });

  it('keeps the base path for the default namespace', () => {
    expect(socketIoConnectUrl('https://example.com/api', undefined)).toBe(
      'https://example.com/api'
    );
    expect(socketIoConnectUrl('https://example.com', '/')).toBe('https://example.com/');
    expect(socketIoConnectUrl('https://example.com', '')).toBe('https://example.com/');
  });

  it('replaces the base path with a namespace', () => {
    expect(socketIoConnectUrl('https://example.com/api', '/admin')).toBe(
      'https://example.com/admin'
    );
    expect(socketIoConnectUrl('https://example.com:8443', 'chat')).toBe(
      'https://example.com:8443/chat'
    );
  });

  it('keeps the query string when joining a namespace', () => {
    expect(socketIoConnectUrl('https://example.com/api?token=abc&x=1', '/admin')).toBe(
      'https://example.com/admin?token=abc&x=1'
    );
    expect(parse(socketIoConnectUrl('https://example.com?token=abc', 'chat')).query).toBe(
      'token=abc'
    );
  });

  it('throws on an unparseable URL', () => {
    expect(() => socketIoConnectUrl('not a url', undefined)).toThrow();
  });
});
