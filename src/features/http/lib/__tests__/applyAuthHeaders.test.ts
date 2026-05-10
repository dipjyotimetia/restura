import { describe, it, expect } from 'vitest';
import { applyAuthHeaders, applyApiKeyQueryParam } from '../applyAuthHeaders';
import type { AuthConfig } from '@/types';

describe('applyAuthHeaders', () => {
  const base: Record<string, string> = { 'Content-Type': 'application/json' };

  it('adds Bearer Authorization for bearer auth', async () => {
    const auth: AuthConfig = { type: 'bearer', bearer: { token: 'my-token' } };
    const result = await applyAuthHeaders(auth, { ...base }, 'https://example.com', 'GET');
    expect(result['Authorization']).toBe('Bearer my-token');
    expect(result['Content-Type']).toBe('application/json');
  });

  it('does nothing for bearer auth with no token', async () => {
    const auth: AuthConfig = { type: 'bearer', bearer: { token: '' } };
    const result = await applyAuthHeaders(auth, { ...base }, 'https://example.com', 'GET');
    expect(result['Authorization']).toBeUndefined();
  });

  it('adds Basic Authorization for basic auth', async () => {
    const auth: AuthConfig = { type: 'basic', basic: { username: 'user', password: 'pass' } };
    const result = await applyAuthHeaders(auth, { ...base }, 'https://example.com', 'GET');
    expect(result['Authorization']).toBe(`Basic ${btoa('user:pass')}`);
  });

  it('adds api-key header when in=header', async () => {
    const auth: AuthConfig = { type: 'api-key', apiKey: { key: 'X-API-Key', value: 'abc123', in: 'header' } };
    const result = await applyAuthHeaders(auth, { ...base }, 'https://example.com', 'GET');
    expect(result['X-API-Key']).toBe('abc123');
  });

  it('does not add api-key header when in=query', async () => {
    const auth: AuthConfig = { type: 'api-key', apiKey: { key: 'api_key', value: 'abc', in: 'query' } };
    const result = await applyAuthHeaders(auth, { ...base }, 'https://example.com', 'GET');
    expect(result['api_key']).toBeUndefined();
  });

  it('adds OAuth2 Authorization with custom tokenType', async () => {
    const auth: AuthConfig = {
      type: 'oauth2',
      oauth2: { accessToken: 'tok', tokenType: 'Token' },
    };
    const result = await applyAuthHeaders(auth, { ...base }, 'https://example.com', 'GET');
    expect(result['Authorization']).toBe('Token tok');
  });

  it('defaults to Bearer tokenType when not set', async () => {
    const auth: AuthConfig = { type: 'oauth2', oauth2: { accessToken: 'tok' } };
    const result = await applyAuthHeaders(auth, { ...base }, 'https://example.com', 'GET');
    expect(result['Authorization']).toBe('Bearer tok');
  });

  it('does nothing for none auth', async () => {
    const auth: AuthConfig = { type: 'none' };
    const result = await applyAuthHeaders(auth, { ...base }, 'https://example.com', 'GET');
    expect(result['Authorization']).toBeUndefined();
    expect(result).toEqual(base);
  });

  it('does not modify original headers object', async () => {
    const headers = { ...base };
    const auth: AuthConfig = { type: 'bearer', bearer: { token: 'tok' } };
    await applyAuthHeaders(auth, headers, 'https://example.com', 'GET');
    expect(headers['Authorization']).toBeUndefined();
  });
});

describe('applyApiKeyQueryParam', () => {
  it('adds api key to query params when in=query', () => {
    const auth: AuthConfig = { type: 'api-key', apiKey: { key: 'api_key', value: 'secret', in: 'query' } };
    const result = applyApiKeyQueryParam(auth, { page: '1' });
    expect(result['api_key']).toBe('secret');
    expect(result['page']).toBe('1');
  });

  it('does not add api key when in=header', () => {
    const auth: AuthConfig = { type: 'api-key', apiKey: { key: 'X-Key', value: 'v', in: 'header' } };
    const result = applyApiKeyQueryParam(auth, {});
    expect(result['X-Key']).toBeUndefined();
  });

  it('returns params unchanged for non-api-key auth', () => {
    const auth: AuthConfig = { type: 'bearer', bearer: { token: 'tok' } };
    const params = { a: 'b' };
    expect(applyApiKeyQueryParam(auth, params)).toBe(params);
  });
});
