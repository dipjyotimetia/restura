// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  redactAuthForExport,
  authHasPlaintextSecret,
} from '../collection-export-redactor';

describe('redactAuthForExport', () => {
  it('returns non-object inputs unchanged', () => {
    expect(redactAuthForExport(undefined)).toBeUndefined();
    expect(redactAuthForExport(null)).toBeNull();
    expect(redactAuthForExport('not-an-object')).toBe('not-an-object');
    expect(redactAuthForExport(42)).toBe(42);
  });

  it('drops plaintext bearer tokens', () => {
    const auth = { type: 'bearer', bearer: { token: 'super-secret-jwt' } };
    expect(redactAuthForExport(auth)).toEqual({
      type: 'bearer',
      bearer: { token: '' },
    });
  });

  it('drops plaintext basic-auth password but keeps username', () => {
    const auth = {
      type: 'basic',
      basic: { username: 'alice', password: 'wonderland' },
    };
    expect(redactAuthForExport(auth)).toEqual({
      type: 'basic',
      basic: { username: 'alice', password: '' },
    });
  });

  it('drops plaintext apiKey value but keeps key name and placement', () => {
    const auth = {
      type: 'api-key',
      apiKey: { key: 'X-API-Key', value: 'abc123', in: 'header' },
    };
    expect(redactAuthForExport(auth)).toEqual({
      type: 'api-key',
      apiKey: { key: 'X-API-Key', value: '', in: 'header' },
    });
  });

  it('drops every secret-bearing oauth2 field', () => {
    const auth = {
      type: 'oauth2',
      oauth2: {
        accessToken: 'at-secret',
        refreshToken: 'rt-secret',
        clientSecret: 'cs-secret',
        password: 'pw-secret',
        clientId: 'client-id-not-secret',
        scope: 'read write',
      },
    };
    const result = redactAuthForExport(auth) as { oauth2: Record<string, unknown> };
    expect(result.oauth2.accessToken).toBe('');
    expect(result.oauth2.refreshToken).toBe('');
    expect(result.oauth2.clientSecret).toBe('');
    expect(result.oauth2.password).toBe('');
    // non-secret fields preserved
    expect(result.oauth2.clientId).toBe('client-id-not-secret');
    expect(result.oauth2.scope).toBe('read write');
  });

  it('drops every secret-bearing oauth1 field', () => {
    const auth = {
      type: 'oauth1',
      oauth1: {
        consumerKey: 'ck-public',
        consumerSecret: 'cs-secret',
        accessToken: 'at-secret',
        accessTokenSecret: 'ats-secret',
        signatureMethod: 'HMAC-SHA1',
      },
    };
    const result = redactAuthForExport(auth) as { oauth1: Record<string, unknown> };
    expect(result.oauth1.consumerKey).toBe('ck-public');
    expect(result.oauth1.consumerSecret).toBe('');
    expect(result.oauth1.accessToken).toBe('');
    expect(result.oauth1.accessTokenSecret).toBe('');
    expect(result.oauth1.signatureMethod).toBe('HMAC-SHA1');
  });

  it('drops AWS secretKey but keeps accessKey, region, service', () => {
    const auth = {
      type: 'aws-signature',
      awsSignature: {
        accessKey: 'AKIA...',
        secretKey: 'tHe-rEaL-sEcReT',
        region: 'us-east-1',
        service: 's3',
      },
    };
    expect(redactAuthForExport(auth)).toEqual({
      type: 'aws-signature',
      awsSignature: {
        accessKey: 'AKIA...',
        secretKey: '',
        region: 'us-east-1',
        service: 's3',
      },
    });
  });

  it('preserves handle references (opaque on their own, useful on same-machine re-import)', () => {
    const auth = {
      type: 'bearer',
      bearer: { token: { kind: 'handle', id: 'uuid-1234', label: 'Prod API' } },
    };
    expect(redactAuthForExport(auth)).toEqual({
      type: 'bearer',
      bearer: { token: { kind: 'handle', id: 'uuid-1234', label: 'Prod API' } },
    });
  });

  it('preserves shape but drops value for inline SecretRef', () => {
    const auth = {
      type: 'bearer',
      bearer: { token: { kind: 'inline', value: 'plaintext-jwt' } },
    };
    expect(redactAuthForExport(auth)).toEqual({
      type: 'bearer',
      bearer: { token: { kind: 'inline', value: '' } },
    });
  });

  it('drops malformed-shape secrets to empty string (fail-closed)', () => {
    const auth = {
      type: 'bearer',
      // missing `kind` — not a valid SecretRef
      bearer: { token: { value: 'plaintext-jwt' } as unknown as string },
    };
    const result = redactAuthForExport(auth) as { bearer: Record<string, unknown> };
    expect(result.bearer.token).toBe('');
  });

  it('handles every auth block at once without cross-contamination', () => {
    const auth = {
      type: 'bearer',
      basic: { username: 'u', password: 'p' },
      bearer: { token: 't' },
      apiKey: { key: 'k', value: 'v', in: 'header' },
      digest: { username: 'du', password: 'dp' },
      wsse: { username: 'wu', password: 'wp', passwordType: 'PasswordDigest' },
      ntlm: { username: 'nu', password: 'np', domain: 'CORP' },
    };
    const result = redactAuthForExport(auth) as Record<string, Record<string, unknown>>;
    expect(result.basic).toBeDefined();
    expect(result.basic!.password).toBe('');
    expect(result.basic!.username).toBe('u');
    expect(result.bearer!.token).toBe('');
    expect(result.apiKey!.value).toBe('');
    expect(result.apiKey!.key).toBe('k');
    expect(result.digest!.password).toBe('');
    expect(result.wsse!.password).toBe('');
    expect(result.wsse!.passwordType).toBe('PasswordDigest');
    expect(result.ntlm!.password).toBe('');
    expect(result.ntlm!.domain).toBe('CORP');
  });

  it('does not mutate the input', () => {
    const auth = { type: 'bearer', bearer: { token: 'secret' } };
    redactAuthForExport(auth);
    expect(auth.bearer.token).toBe('secret');
  });

  it('preserves unknown top-level fields untouched', () => {
    const auth = {
      type: 'bearer',
      bearer: { token: 'secret' },
      customFutureField: { keep: 'me' },
    };
    const result = redactAuthForExport(auth) as Record<string, unknown>;
    expect(result.customFutureField).toEqual({ keep: 'me' });
  });

  it('ignores top-level non-object auth blocks', () => {
    // E.g. someone stored `bearer: "raw-token"` instead of an object — skip
    // rather than throw. Partially-redacted export is acceptable.
    const auth = { type: 'bearer', bearer: 'raw-token-not-an-object' };
    expect(redactAuthForExport(auth)).toEqual(auth);
  });
});

describe('authHasPlaintextSecret', () => {
  it('returns false for non-object', () => {
    expect(authHasPlaintextSecret(undefined)).toBe(false);
    expect(authHasPlaintextSecret('s')).toBe(false);
  });

  it('detects plaintext string secret', () => {
    expect(authHasPlaintextSecret({ type: 'bearer', bearer: { token: 'x' } })).toBe(true);
  });

  it('detects inline SecretRef with non-empty value', () => {
    expect(
      authHasPlaintextSecret({
        type: 'bearer',
        bearer: { token: { kind: 'inline', value: 'x' } },
      })
    ).toBe(true);
  });

  it('returns false for empty inline SecretRef', () => {
    expect(
      authHasPlaintextSecret({
        type: 'bearer',
        bearer: { token: { kind: 'inline', value: '' } },
      })
    ).toBe(false);
  });

  it('returns false for handle reference', () => {
    expect(
      authHasPlaintextSecret({
        type: 'bearer',
        bearer: { token: { kind: 'handle', id: 'uuid' } },
      })
    ).toBe(false);
  });

  it('returns false for empty string secret', () => {
    expect(authHasPlaintextSecret({ type: 'bearer', bearer: { token: '' } })).toBe(false);
  });
});
