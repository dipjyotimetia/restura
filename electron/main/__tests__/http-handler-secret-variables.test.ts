import { describe, expect, it } from 'vitest';
import { materializeSecretVariables } from '../security/secret-variable-materializer';

describe('materializeSecretVariables', () => {
  it('resolves opaque values only at the Electron wire boundary', async () => {
    const materialized = await materializeSecretVariables({
      method: 'POST',
      url: 'https://{{host}}/v1',
      headers: { Authorization: 'Bearer {{token}}' },
      data: '{"token":"{{token}}"}',
      secretVariables: {
        host: { kind: 'inline', value: 'api.example' },
        token: { kind: 'inline', value: 'desktop-secret' },
      },
    });

    expect(materialized.url).toBe('https://api.example/v1');
    expect(materialized.headers).toEqual({ Authorization: 'Bearer desktop-secret' });
    expect(materialized.data).toBe('{"token":"desktop-secret"}');
    expect(materialized.secretVariables).toBeUndefined();
  });

  const secretVariables = {
    user: { kind: 'inline', value: 'alice' },
    pw: { kind: 'inline', value: 'desktop-secret' },
  } as const;

  it('resolves secret-variable tokens in sign-at-wire auth fields', async () => {
    const cases = [
      {
        auth: { type: 'digest', digest: { username: '{{user}}', password: '{{pw}}' } },
        expected: { digest: { username: 'alice', password: 'desktop-secret' } },
      },
      {
        auth: {
          type: 'ntlm',
          ntlm: { username: '{{user}}', password: { kind: 'inline', value: '{{pw}}' } },
        },
        expected: {
          ntlm: { username: 'alice', password: { kind: 'inline', value: 'desktop-secret' } },
        },
      },
      {
        auth: { type: 'wsse', wsse: { username: '{{user}}', password: '{{pw}}' } },
        expected: { wsse: { username: 'alice', password: 'desktop-secret' } },
      },
      {
        auth: {
          type: 'aws-signature',
          awsSignature: {
            accessKey: '{{user}}',
            secretKey: '{{pw}}',
            region: 'us-east-1',
            service: 's3',
          },
        },
        expected: {
          awsSignature: {
            accessKey: 'alice',
            secretKey: 'desktop-secret',
            region: 'us-east-1',
            service: 's3',
          },
        },
      },
      {
        auth: {
          type: 'oauth1',
          oauth1: {
            consumerKey: '{{user}}',
            consumerSecret: '{{pw}}',
            accessToken: 't',
            accessTokenSecret: '{{pw}}',
          },
        },
        expected: {
          oauth1: {
            consumerKey: 'alice',
            consumerSecret: 'desktop-secret',
            accessToken: 't',
            accessTokenSecret: 'desktop-secret',
          },
        },
      },
    ] as const;
    for (const { auth, expected } of cases) {
      const materialized = await materializeSecretVariables({
        url: 'https://api.example/v1',
        auth: auth as never,
        secretVariables,
      });
      expect(materialized.auth).toMatchObject({ type: auth.type, ...expected });
    }
  });

  it('resolves header-shaped auth values (basic) but never the api-key name or handles', async () => {
    const handle = { kind: 'handle', id: 'h-1' } as const;
    const basic = await materializeSecretVariables({
      url: 'https://api.example/v1',
      auth: { type: 'basic', basic: { username: '{{user}}', password: '{{pw}}' } } as never,
      secretVariables,
    });
    expect(basic.auth).toEqual({
      type: 'basic',
      basic: { username: 'alice', password: 'desktop-secret' },
    });
    const apiKey = await materializeSecretVariables({
      url: 'https://api.example/v1',
      auth: {
        type: 'api-key',
        apiKey: { key: '{{user}}', value: '{{pw}}', in: 'header' },
      } as never,
      secretVariables,
    });
    expect(apiKey.auth).toEqual({
      type: 'api-key',
      apiKey: { key: '{{user}}', value: 'desktop-secret', in: 'header' },
    });
    const digest = await materializeSecretVariables({
      url: 'https://api.example/v1',
      auth: { type: 'digest', digest: { username: '{{user}}', password: handle } } as never,
      secretVariables,
    });
    expect((digest.auth as { digest: { password: unknown } }).digest.password).toBe(handle);
  });
});
