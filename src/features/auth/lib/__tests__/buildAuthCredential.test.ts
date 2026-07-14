import { describe, expect, it } from 'vitest';
import type { AuthConfig } from '@/types';
import { buildAuthCredential } from '../buildAuthCredential';

describe('buildAuthCredential', () => {
  describe('none / undefined', () => {
    it('returns empty for undefined auth', () => {
      expect(buildAuthCredential(undefined)).toEqual({ headers: {}, params: {} });
    });

    it('returns empty for none type', () => {
      const auth: AuthConfig = { type: 'none' };
      expect(buildAuthCredential(auth)).toEqual({ headers: {}, params: {} });
    });
  });

  describe('bearer', () => {
    it('emits Authorization: Bearer <token> with default casing', () => {
      const auth: AuthConfig = { type: 'bearer', bearer: { token: 'tok-1' } };
      expect(buildAuthCredential(auth)).toEqual({
        headers: { Authorization: 'Bearer tok-1' },
        params: {},
      });
    });

    it('emits lowercase authorization key when headerCase=lower', () => {
      const auth: AuthConfig = { type: 'bearer', bearer: { token: 'tok-1' } };
      expect(buildAuthCredential(auth, { headerCase: 'lower' })).toEqual({
        headers: { authorization: 'Bearer tok-1' },
        params: {},
      });
    });

    it('returns empty when token is missing', () => {
      const auth: AuthConfig = { type: 'bearer', bearer: { token: '' } };
      expect(buildAuthCredential(auth)).toEqual({ headers: {}, params: {} });
    });

    it('returns empty when bearer block is missing entirely', () => {
      const auth = { type: 'bearer' } as AuthConfig;
      expect(buildAuthCredential(auth)).toEqual({ headers: {}, params: {} });
    });
  });

  describe('basic', () => {
    it('emits Basic <base64(user:pass)>', () => {
      const auth: AuthConfig = { type: 'basic', basic: { username: 'alice', password: 'wonder' } };
      expect(buildAuthCredential(auth)).toEqual({
        headers: { Authorization: `Basic ${btoa('alice:wonder')}` },
        params: {},
      });
    });

    it('allows empty password by default (HTTP semantics)', () => {
      const auth: AuthConfig = { type: 'basic', basic: { username: 'alice', password: '' } };
      expect(buildAuthCredential(auth)).toEqual({
        headers: { Authorization: `Basic ${btoa('alice:')}` },
        params: {},
      });
    });

    it('returns empty when username missing', () => {
      const auth: AuthConfig = { type: 'basic', basic: { username: '', password: 'pw' } };
      expect(buildAuthCredential(auth)).toEqual({ headers: {}, params: {} });
    });

    it('with basicRequiresPassword, requires both username and password (gRPC semantics)', () => {
      const auth: AuthConfig = { type: 'basic', basic: { username: 'alice', password: '' } };
      expect(buildAuthCredential(auth, { basicRequiresPassword: true })).toEqual({
        headers: {},
        params: {},
      });
    });

    it('with basicRequiresPassword, both present still works', () => {
      const auth: AuthConfig = { type: 'basic', basic: { username: 'u', password: 'p' } };
      expect(
        buildAuthCredential(auth, { basicRequiresPassword: true, headerCase: 'lower' })
      ).toEqual({
        headers: { authorization: `Basic ${btoa('u:p')}` },
        params: {},
      });
    });
  });

  describe('api-key', () => {
    it('emits header key=value with preserved casing for in=header', () => {
      const auth: AuthConfig = {
        type: 'api-key',
        apiKey: { key: 'X-API-Key', value: 'abc', in: 'header' },
      };
      expect(buildAuthCredential(auth)).toEqual({
        headers: { 'X-API-Key': 'abc' },
        params: {},
      });
    });

    it('lowercases the api-key header when headerCase=lower', () => {
      const auth: AuthConfig = {
        type: 'api-key',
        apiKey: { key: 'X-API-Key', value: 'abc', in: 'header' },
      };
      expect(buildAuthCredential(auth, { headerCase: 'lower' })).toEqual({
        headers: { 'x-api-key': 'abc' },
        params: {},
      });
    });

    it('emits a query param when in=query', () => {
      const auth: AuthConfig = {
        type: 'api-key',
        apiKey: { key: 'api_key', value: 'secret', in: 'query' },
      };
      expect(buildAuthCredential(auth)).toEqual({
        headers: {},
        params: { api_key: 'secret' },
      });
    });

    it('returns empty if key or value missing', () => {
      const auth1: AuthConfig = { type: 'api-key', apiKey: { key: '', value: 'v', in: 'header' } };
      const auth2: AuthConfig = { type: 'api-key', apiKey: { key: 'k', value: '', in: 'header' } };
      expect(buildAuthCredential(auth1)).toEqual({ headers: {}, params: {} });
      expect(buildAuthCredential(auth2)).toEqual({ headers: {}, params: {} });
    });
  });

  describe('oauth2', () => {
    it('emits Authorization: Bearer <token> by default', () => {
      const auth: AuthConfig = { type: 'oauth2', oauth2: { accessToken: 'oat' } };
      expect(buildAuthCredential(auth)).toEqual({
        headers: { Authorization: 'Bearer oat' },
        params: {},
      });
    });

    it('uses custom tokenType when set', () => {
      const auth: AuthConfig = { type: 'oauth2', oauth2: { accessToken: 'oat', tokenType: 'MAC' } };
      expect(buildAuthCredential(auth, { headerCase: 'lower' })).toEqual({
        headers: { authorization: 'MAC oat' },
        params: {},
      });
    });

    it('returns empty when accessToken missing', () => {
      const auth: AuthConfig = { type: 'oauth2', oauth2: { accessToken: '' } };
      expect(buildAuthCredential(auth)).toEqual({ headers: {}, params: {} });
    });
  });

  describe('sign-at-wire types are not handled here', () => {
    it.each([
      'digest',
      'oauth1',
      'aws-signature',
      'ntlm',
      'wsse',
    ] as const)('%s returns empty (caller signs at wire time)', (type) => {
      const auth = { type } as AuthConfig;
      expect(buildAuthCredential(auth)).toEqual({ headers: {}, params: {} });
    });
  });
});
