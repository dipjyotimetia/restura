import { describe, expect, it } from 'vitest';
import { buildSocketIOConnectUrl, validateSocketIOUrl } from '@/features/socketio/lib/url-helpers';

describe('buildSocketIOConnectUrl', () => {
  it('returns the URL unchanged when namespace is "/"', () => {
    expect(buildSocketIOConnectUrl('https://example.com', '/')).toBe('https://example.com');
  });

  it('returns the URL unchanged when namespace is empty or undefined', () => {
    expect(buildSocketIOConnectUrl('https://example.com', '')).toBe('https://example.com');
    expect(buildSocketIOConnectUrl('https://example.com', undefined)).toBe('https://example.com');
  });

  it('appends the namespace path to the origin', () => {
    expect(buildSocketIOConnectUrl('https://example.com', '/chat')).toBe(
      'https://example.com/chat'
    );
  });

  it('normalises a namespace without leading slash', () => {
    expect(buildSocketIOConnectUrl('https://example.com', 'chat')).toBe('https://example.com/chat');
  });

  it('strips any path on the base URL in favour of the namespace', () => {
    expect(buildSocketIOConnectUrl('https://example.com/api', '/admin')).toBe(
      'https://example.com/admin'
    );
  });

  it('returns the raw URL on parse failure', () => {
    expect(buildSocketIOConnectUrl('not a url', '/chat')).toBe('not a url');
  });
});

describe('validateSocketIOUrl', () => {
  it.each([
    ['https://example.com'],
    ['http://localhost:3000'],
    ['ws://example.com'],
    ['wss://example.com'],
  ])('accepts %s', (url) => {
    expect(validateSocketIOUrl(url).valid).toBe(true);
  });

  it('rejects empty input', () => {
    expect(validateSocketIOUrl('').valid).toBe(false);
  });

  it('rejects unsupported protocols', () => {
    expect(validateSocketIOUrl('ftp://example.com').valid).toBe(false);
    expect(validateSocketIOUrl('file:///etc/passwd').valid).toBe(false);
  });

  it('rejects unparseable input', () => {
    expect(validateSocketIOUrl('   garbage   ').valid).toBe(false);
  });
});
