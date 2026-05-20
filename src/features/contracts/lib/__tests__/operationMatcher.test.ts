import { describe, it, expect } from 'vitest';
import {
  extractPath,
  findOperationById,
  matchOperation,
  matchPathTemplate,
} from '../operationMatcher';
import type { AnyOpenAPISpec } from '../operationMatcher';

const minimalSpec: AnyOpenAPISpec = {
  openapi: '3.0.0',
  info: { title: 'test', version: '1' },
  servers: [{ url: 'https://api.example.com/v1' }],
  paths: {
    '/users': {
      get: { operationId: 'listUsers', responses: { '200': { description: 'ok' } } },
      post: { operationId: 'createUser', responses: { '201': { description: 'created' } } },
    },
    '/users/{id}': {
      get: { operationId: 'getUser', responses: { '200': { description: 'ok' } } },
      delete: { operationId: 'deleteUser', responses: { '204': { description: 'noContent' } } },
    },
    '/users/{id}/posts/{postId}': {
      get: { operationId: 'getUserPost', responses: { '200': { description: 'ok' } } },
    },
    '/health': {
      // No operationId — synthetic key should still allow matching.
      get: { responses: { '200': { description: 'ok' } } },
    },
  },
};

describe('matchPathTemplate', () => {
  it('matches a static path', () => {
    expect(matchPathTemplate('/users', '/users')).toEqual({});
  });

  it('extracts single param', () => {
    expect(matchPathTemplate('/users/{id}', '/users/42')).toEqual({ id: '42' });
  });

  it('extracts multiple params', () => {
    expect(matchPathTemplate('/users/{id}/posts/{postId}', '/users/42/posts/abc')).toEqual({
      id: '42',
      postId: 'abc',
    });
  });

  it('returns null when segment counts differ', () => {
    expect(matchPathTemplate('/users/{id}', '/users/42/posts')).toBeNull();
    expect(matchPathTemplate('/users/{id}', '/users')).toBeNull();
  });

  it('returns null for non-matching static segments', () => {
    expect(matchPathTemplate('/users/{id}', '/admins/42')).toBeNull();
  });

  it('treats trailing slash as equivalent', () => {
    expect(matchPathTemplate('/users/{id}', '/users/42/')).toEqual({ id: '42' });
    expect(matchPathTemplate('/users/{id}/', '/users/42')).toEqual({ id: '42' });
  });

  it('decodes URI-encoded params', () => {
    expect(matchPathTemplate('/users/{id}', '/users/john%40acme.com')).toEqual({
      id: 'john@acme.com',
    });
  });

  it('does NOT match across slash boundaries', () => {
    // A param matches exactly one segment.
    expect(matchPathTemplate('/users/{id}', '/users/42/extra')).toBeNull();
  });
});

describe('extractPath', () => {
  it('strips host from a full URL', () => {
    expect(extractPath('https://api.example.com/v1/users/42', minimalSpec)).toBe('/users/42');
  });

  it('strips query and fragment', () => {
    expect(extractPath('https://api.example.com/v1/users?q=x#section', minimalSpec)).toBe('/users');
  });

  it('handles path-only inputs', () => {
    expect(extractPath('/v1/users/42', minimalSpec)).toBe('/users/42');
  });

  it('returns root when path matches the server prefix exactly', () => {
    expect(extractPath('https://api.example.com/v1', minimalSpec)).toBe('/');
  });

  it('falls back to the raw pathname when no server prefix matches', () => {
    const spec: AnyOpenAPISpec = { ...minimalSpec, servers: [{ url: 'https://other.example.com' }] };
    // No server prefix to strip — return the path as-is.
    expect(extractPath('https://api.example.com/v1/users/42', spec)).toBe('/v1/users/42');
  });

  it('handles relative server urls', () => {
    const spec: AnyOpenAPISpec = { ...minimalSpec, servers: [{ url: '/api' }] };
    expect(extractPath('https://example.com/api/users/42', spec)).toBe('/users/42');
  });
});

describe('matchOperation', () => {
  it('matches a static GET path', () => {
    const m = matchOperation(minimalSpec, 'GET', 'https://api.example.com/v1/users');
    expect(m?.operationId).toBe('listUsers');
    expect(m?.pathTemplate).toBe('/users');
    expect(m?.method).toBe('get');
  });

  it('matches a templated GET path and extracts params', () => {
    const m = matchOperation(minimalSpec, 'GET', 'https://api.example.com/v1/users/42');
    expect(m?.operationId).toBe('getUser');
    expect(m?.pathParams).toEqual({ id: '42' });
  });

  it('matches deeply nested templated paths', () => {
    const m = matchOperation(minimalSpec, 'GET', 'https://api.example.com/v1/users/42/posts/abc');
    expect(m?.operationId).toBe('getUserPost');
    expect(m?.pathParams).toEqual({ id: '42', postId: 'abc' });
  });

  it('returns null when no path matches', () => {
    expect(matchOperation(minimalSpec, 'GET', 'https://api.example.com/v1/orders')).toBeNull();
  });

  it('returns null when method does not match the path', () => {
    expect(matchOperation(minimalSpec, 'PATCH', 'https://api.example.com/v1/users/42')).toBeNull();
  });

  it('falls back to a synthetic operationId when none is declared', () => {
    const m = matchOperation(minimalSpec, 'GET', 'https://api.example.com/v1/health');
    expect(m?.operationId).toBe('GET /health');
  });

  it('rejects unknown methods', () => {
    expect(matchOperation(minimalSpec, 'CONNECT', 'https://api.example.com/v1/users')).toBeNull();
    expect(matchOperation(minimalSpec, 'FROBNICATE', 'https://api.example.com/v1/users')).toBeNull();
  });
});

describe('findOperationById', () => {
  it('looks up by explicit operationId', () => {
    expect(findOperationById(minimalSpec, 'getUser')?.pathTemplate).toBe('/users/{id}');
  });

  it('looks up by synthetic operationId for operations without one', () => {
    expect(findOperationById(minimalSpec, 'GET /health')?.pathTemplate).toBe('/health');
  });

  it('returns null for unknown ids', () => {
    expect(findOperationById(minimalSpec, 'noSuchOp')).toBeNull();
  });
});
