import { describe, expect, it } from 'vitest';
import {
  sanitizeConsoleEntry,
  sanitizeConsoleHeaders,
  sanitizeConsoleUrl,
} from '../console-sanitization';

const response = {
  id: 'response',
  requestId: 'request',
  status: 200,
  statusText: 'OK',
  headers: {},
  body: '',
  size: 0,
  time: 1,
  timestamp: 1,
};

describe('console sanitization edge cases', () => {
  it('redacts URL userinfo and credential query parameters in malformed templates', () => {
    expect(sanitizeConsoleUrl('https://user:password@api.example.test/users')).toContain(
      '%5BREDACTED%5D:%5BREDACTED%5D@'
    );
    expect(sanitizeConsoleUrl('{{baseUrl}}/users?token=plaintext-secret&page=2')).toBe(
      '{{baseUrl}}/users?token=[REDACTED]&page=2'
    );
  });

  it('keeps arrays for safe headers while redacting credential headers', () => {
    expect(
      sanitizeConsoleHeaders({ Accept: ['application/json'], Cookie: ['session=plaintext'] })
    ).toEqual({
      Accept: ['application/json'],
      Cookie: ['[REDACTED]'],
    });
  });

  it('redacts every setCookies value but keeps names + known attributes for the Cookies view (#855)', () => {
    const entry = sanitizeConsoleEntry({
      timestamp: 1,
      protocol: 'http',
      request: { method: 'GET', url: 'https://api.example.test', headers: {} },
      response: {
        ...response,
        headers: { 'set-cookie': 'pref=dark' },
        setCookies: [
          'session=plaintext-secret; Path=/; HttpOnly; Secure; SameSite=Lax',
          'csrf=tok; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Max-Age=60; Domain=example.test',
          'pref=dark; X-Custom=leaky-secret; Partitioned',
          'no-pair-secret',
        ],
      },
    });
    expect(entry.response.headers['set-cookie']).toBe('[REDACTED]');
    expect(entry.response.setCookies).toEqual([
      'session=[REDACTED]; Path=/; HttpOnly; Secure; SameSite=Lax',
      'csrf=[REDACTED]; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Max-Age=60; Domain=example.test',
      'pref=[REDACTED]; Partitioned',
      '[REDACTED]',
    ]);
    const json = JSON.stringify(entry);
    for (const secret of ['plaintext-secret', '=tok', 'dark', 'leaky-secret', 'no-pair-secret']) {
      expect(json).not.toContain(secret);
    }
  });

  it('preserves optional native-draft fields after sanitization', () => {
    const http = sanitizeConsoleEntry({
      timestamp: 1,
      protocol: 'http',
      request: { method: 'GET', url: 'https://api.example.test', headers: {} },
      response,
      nativeDraft: {
        kind: 'http',
        credentialsOmitted: true,
        method: 'GET',
        url: 'https://api.example.test',
        headers: {},
        body: '',
      },
    });
    const graphql = sanitizeConsoleEntry({
      timestamp: 1,
      protocol: 'graphql',
      request: { method: 'POST', url: 'https://api.example.test/graphql', headers: {} },
      response,
      nativeDraft: {
        kind: 'graphql',
        credentialsOmitted: true,
        url: 'https://api.example.test/graphql',
        headers: {},
        query: 'query Viewer { viewer { id } }',
        variables: '{}',
        operationName: 'Viewer',
      },
    });

    expect(http.nativeDraft).toMatchObject({ body: '' });
    expect(graphql.nativeDraft).toMatchObject({ operationName: 'Viewer' });
  });
});
