import {
  detectUnredactedSecrets,
  redactBody,
  redactEnvironment,
  redactHeaders,
} from '@shared/protocol/ai/redaction';
import { describe, expect, it } from 'vitest';

describe('redactHeaders', () => {
  it('strips Authorization, Cookie, Set-Cookie', () => {
    const out = redactHeaders(
      {
        Authorization: 'Bearer sk-12345',
        Cookie: 'session=abc',
        'Set-Cookie': 'x=y',
        'Content-Type': 'application/json',
      },
      'default'
    );
    expect(out.Authorization).toBe('[REDACTED]');
    expect(out.Cookie).toBe('[REDACTED]');
    expect(out['Set-Cookie']).toBe('[REDACTED]');
    expect(out['Content-Type']).toBe('application/json');
  });

  it('strips x-*-token / x-*-key / x-*-secret via regex', () => {
    const out = redactHeaders(
      { 'X-Auth-Token': 'abc', 'X-Api-Key': 'def', 'X-Client-Secret': 'ghi' },
      'default'
    );
    expect(out['X-Auth-Token']).toBe('[REDACTED]');
    expect(out['X-Api-Key']).toBe('[REDACTED]');
    expect(out['X-Client-Secret']).toBe('[REDACTED]');
  });

  it('header matching is case-insensitive', () => {
    const out = redactHeaders({ AUTHORIZATION: 'Bearer x' }, 'default');
    expect(out.AUTHORIZATION).toBe('[REDACTED]');
  });

  it('raw mode is a passthrough', () => {
    const headers = { Authorization: 'Bearer sk-12345' };
    const out = redactHeaders(headers, 'raw');
    expect(out.Authorization).toBe('Bearer sk-12345');
  });
});

describe('redactBody', () => {
  it('masks JWTs in body text', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = redactBody(`{"token": "${jwt}"}`, 'default');
    expect(out).not.toContain(jwt);
    expect(out).toContain('[REDACTED]');
  });

  it('masks Bearer <token> tails', () => {
    const out = redactBody(
      'curl -H "Authorization: Bearer sk-abcdefghijklmnopqrst" https://api',
      'default'
    );
    expect(out).not.toContain('sk-abcdefghijklmnopqrst');
  });

  it('masks api_key / secret / password / token assignments', () => {
    const out = redactBody('api_key="ZGVhZGJlZWZkZWFkYmVlZg"', 'default');
    expect(out).not.toContain('ZGVhZGJlZWZkZWFkYmVlZg');
  });

  it('masks Authorization: Basic credentials but not prose', () => {
    const out = redactBody('Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==', 'default');
    expect(out).not.toContain('dXNlcjpwYXNzd29yZDEyMw');
    expect(redactBody('Use Basic authentication here', 'default')).toBe(
      'Use Basic authentication here'
    );
  });

  it('masks whole PEM private key blocks, including a truncated one', () => {
    const block =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabc123\nzzzz9999\n-----END RSA PRIVATE KEY-----';
    const out = redactBody(`before ${block} after`, 'default');
    expect(out).toBe('before [REDACTED] after');
    const cut = redactBody('x -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq', 'default');
    expect(cut).not.toContain('MIIEvQ');
  });

  it('masks presigned-URL signatures and session tokens', () => {
    const out = redactBody(
      'https://b.s3.amazonaws.com/o?X-Amz-Credential=AKIDEXAMPLE%2F2026&X-Amz-Signature=0123456789abcdef0123&X-Amz-Security-Token=FwoGZXIvYXdz%2Babc',
      'default'
    );
    expect(out).not.toContain('0123456789abcdef0123');
    expect(out).not.toContain('FwoGZXIvYXdz');
  });

  it('raw mode is passthrough', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig';
    const out = redactBody(jwt, 'raw');
    expect(out).toBe(jwt);
  });
});

describe('redactEnvironment', () => {
  it('exposes names but not values', () => {
    const out = redactEnvironment(
      { baseUrl: 'https://example.com', apiKey: 'sk-12345' },
      'default'
    );
    expect(out).toEqual({ baseUrl: '[REDACTED]', apiKey: '[REDACTED]' });
  });

  it('raw mode passes values through', () => {
    const env = { baseUrl: 'https://example.com', apiKey: 'sk-12345' };
    const out = redactEnvironment(env, 'raw');
    expect(out).toEqual(env);
  });
});

describe('detectUnredactedSecrets (backend paranoia pass)', () => {
  it('returns true when body still has Bearer sk-', () => {
    expect(detectUnredactedSecrets('Authorization: Bearer sk-abcdef123456')).toBe(true);
  });

  it('returns true when body still has a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sigsigsigsigsigsig';
    expect(detectUnredactedSecrets(`{"token":"${jwt}"}`)).toBe(true);
  });

  it('returns false on clean redacted text', () => {
    expect(detectUnredactedSecrets('Authorization: [REDACTED]')).toBe(false);
  });
});
