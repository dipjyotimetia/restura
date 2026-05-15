import { describe, it, expect } from 'vitest';
import { __test__ } from '@/features/socketio/lib/socketioManager';

const { buildConnectUrl, validateUrl, kvToRecord } = __test__;

describe('socketioManager helpers', () => {
  describe('buildConnectUrl', () => {
    it('returns the URL unchanged when namespace is "/"', () => {
      expect(buildConnectUrl('https://example.com', '/')).toBe('https://example.com');
    });

    it('returns the URL unchanged when namespace is empty', () => {
      expect(buildConnectUrl('https://example.com', '')).toBe('https://example.com');
    });

    it('appends the namespace path to the origin', () => {
      expect(buildConnectUrl('https://example.com', '/chat')).toBe('https://example.com/chat');
    });

    it('normalises a namespace without leading slash', () => {
      expect(buildConnectUrl('https://example.com', 'chat')).toBe('https://example.com/chat');
    });

    it('strips any path on the base URL in favour of the namespace', () => {
      expect(buildConnectUrl('https://example.com/api', '/admin')).toBe('https://example.com/admin');
    });

    it('returns the raw URL on parse failure', () => {
      expect(buildConnectUrl('not a url', '/chat')).toBe('not a url');
    });
  });

  describe('validateUrl', () => {
    it.each([
      ['https://example.com'],
      ['http://localhost:3000'],
      ['ws://example.com'],
      ['wss://example.com'],
    ])('accepts %s', (url) => {
      expect(validateUrl(url).valid).toBe(true);
    });

    it('rejects empty input', () => {
      expect(validateUrl('').valid).toBe(false);
    });

    it('rejects unsupported protocols', () => {
      expect(validateUrl('ftp://example.com').valid).toBe(false);
      expect(validateUrl('file:///etc/passwd').valid).toBe(false);
    });

    it('rejects unparseable input', () => {
      expect(validateUrl('   garbage   ').valid).toBe(false);
    });
  });

  describe('kvToRecord', () => {
    it('skips disabled and empty-key entries', () => {
      const result = kvToRecord([
        { id: '1', key: 'token', value: 'abc', enabled: true },
        { id: '2', key: '', value: 'orphan', enabled: true },
        { id: '3', key: 'disabled', value: 'nope', enabled: false },
        { id: '4', key: 'room', value: 'lobby', enabled: true },
      ]);
      expect(result).toEqual({ token: 'abc', room: 'lobby' });
    });

    it('handles an empty list', () => {
      expect(kvToRecord([])).toEqual({});
    });
  });
});
