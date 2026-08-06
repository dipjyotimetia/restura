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
