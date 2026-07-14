import { describe, expect, it } from 'vitest';
import { SECRET_FIELDS_BY_AUTH_BLOCK } from '@/lib/shared/auth-secret-fields';
import { redactEnvironmentVariables, redactSecretsDeep } from '../redaction';

describe('redactSecretsDeep — SecretRef shapes (post-migration)', () => {
  it('passes through trees with no secret-named fields', () => {
    const input = { name: 'foo', url: 'https://example.com', method: 'GET' };
    expect(redactSecretsDeep(input)).toBe(input);
  });

  it('blanks inline SecretRef under a secret field name', () => {
    const input = {
      auth: { basic: { username: 'u', password: { kind: 'inline', value: 'p' } } },
    };
    const out = redactSecretsDeep(input);
    expect(out.auth.basic.password).toEqual({ kind: 'inline', value: '' });
    expect(out.auth.basic.username).toBe('u');
  });

  it('keeps handle label, drops id', () => {
    const input = {
      auth: {
        awsSignature: {
          accessKey: 'AKIA',
          secretKey: { kind: 'handle', id: 'uuid-1', label: 'AWS prod' },
        },
      },
    };
    const out = redactSecretsDeep(input);
    expect(out.auth.awsSignature.secretKey).toEqual({ kind: 'handle', label: 'AWS prod' });
    expect(out.auth.awsSignature.accessKey).toBe('AKIA');
  });

  it('handles handle without label', () => {
    const input = {
      auth: { bearer: { token: { kind: 'handle', id: 'uuid-2' } } },
    };
    const out = redactSecretsDeep(input);
    expect(out.auth.bearer.token).toEqual({ kind: 'handle', label: '(unnamed)' });
  });

  it('also blanks legacy plain-string values at secret fields', () => {
    const input = { auth: { basic: { password: 'legacy-plaintext' } } };
    const out = redactSecretsDeep(input);
    expect(out.auth.basic.password).toBe('');
  });

  it('redacts apiKey `value` inside an auth subtree', () => {
    const input = {
      auth: { apiKey: { key: 'x-api-key', value: 'super-secret', in: 'header' } },
    };
    const out = redactSecretsDeep(input);
    expect(out.auth.apiKey.value).toBe('');
    expect(out.auth.apiKey.key).toBe('x-api-key');
  });

  it('does NOT wipe `value` outside auth subtrees (env-var listings)', () => {
    const input = {
      variables: [{ key: 'API_URL', value: 'https://example.com' }],
    };
    const out = redactSecretsDeep(input);
    expect(out.variables[0]?.value).toBe('https://example.com');
  });

  it('covers every canonical secret field inside an auth block (drift guard)', () => {
    for (const [block, fields] of Object.entries(SECRET_FIELDS_BY_AUTH_BLOCK)) {
      for (const field of fields) {
        const input = { auth: { [block]: { [field]: 'plaintext-secret' } } };
        const out = redactSecretsDeep(input) as {
          auth: Record<string, Record<string, unknown>>;
        };
        expect(out.auth[block]?.[field], `${block}.${field} must be redacted`).toBe('');
      }
    }
  });

  it('walks nested collections', () => {
    const input = {
      collections: [
        {
          name: 'c',
          items: [
            {
              request: {
                auth: { bearer: { token: { kind: 'inline', value: 'leaky' } } },
              },
            },
          ],
        },
      ],
    };
    const out = redactSecretsDeep(input);
    const token = out.collections[0]?.items[0]?.request.auth.bearer.token;
    expect(token).toEqual({ kind: 'inline', value: '' });
  });
});

describe('redactUrlCredentials', () => {
  // Late import to keep the top of the file focused on the main API.
  it('strips userinfo and masks credential query params', async () => {
    const { redactUrlCredentials } = await import('../redaction');
    expect(redactUrlCredentials('https://user:pass@api.example.com/v1?token=abc&x=1')).toBe(
      'https://api.example.com/v1?token=%28secret%29&x=1'
    );
  });

  it('passes through templated / relative URLs unchanged', async () => {
    const { redactUrlCredentials } = await import('../redaction');
    expect(redactUrlCredentials('{{baseUrl}}/users')).toBe('{{baseUrl}}/users');
    expect(redactUrlCredentials(undefined)).toBeUndefined();
  });
});

describe('redactEnvironmentVariables', () => {
  it('replaces secret-marked variable values with (secret)', () => {
    const out = redactEnvironmentVariables([
      { key: 'API_URL', value: 'https://example.com', enabled: true },
      { key: 'API_KEY', value: 'shhh', enabled: true, secret: true },
    ]);
    expect(out).toEqual([
      { key: 'API_URL', value: 'https://example.com', isSecret: false },
      { key: 'API_KEY', value: '(secret)', isSecret: true },
    ]);
  });

  it('filters out disabled variables', () => {
    const out = redactEnvironmentVariables([
      { key: 'A', value: '1', enabled: false },
      { key: 'B', value: '2', enabled: true },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.key).toBe('B');
  });
});
