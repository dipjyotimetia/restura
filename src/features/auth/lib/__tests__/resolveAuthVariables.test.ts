import { describe, expect, it } from 'vitest';
import type { AuthConfig } from '@/types';
import { resolveAuthVariables } from '../resolveAuthVariables';

const resolve = (text: string) => text.replaceAll('{{v}}', 'X');
const handle = { kind: 'handle', id: 'h-1' } as const;
const external = {
  kind: 'external',
  provider: 'aws-secrets-manager',
  profileId: 'p',
  secretId: 's',
} as const;

describe('resolveAuthVariables', () => {
  it('resolves plain-string and inline SecretRef credential fields', () => {
    expect(resolveAuthVariables({ type: 'bearer', bearer: { token: 'a{{v}}' } }, resolve)).toEqual({
      type: 'bearer',
      bearer: { token: 'aX' },
    });
    expect(
      resolveAuthVariables(
        {
          type: 'basic',
          basic: { username: '{{v}}', password: { kind: 'inline', value: '{{v}}' } },
        },
        resolve
      )
    ).toEqual({
      type: 'basic',
      basic: { username: 'X', password: { kind: 'inline', value: 'X' } },
    });
    expect(
      resolveAuthVariables(
        { type: 'api-key', apiKey: { key: 'k{{v}}', value: '{{v}}', in: 'query' } },
        resolve
      )
    ).toEqual({ type: 'api-key', apiKey: { key: 'kX', value: 'X', in: 'query' } });
    expect(
      resolveAuthVariables(
        { type: 'oauth2', oauth2: { accessToken: '{{v}}', tokenType: '{{v}}', clientId: 'c' } },
        resolve
      )
    ).toEqual({ type: 'oauth2', oauth2: { accessToken: 'X', tokenType: 'X', clientId: 'c' } });
  });

  it('leaves handle and external SecretRefs opaque', () => {
    const auth: AuthConfig = { type: 'bearer', bearer: { token: handle } };
    expect(resolveAuthVariables(auth, resolve).bearer?.token).toBe(handle);
    const ext: AuthConfig = { type: 'oauth2', oauth2: { accessToken: external } };
    expect(resolveAuthVariables(ext, resolve).oauth2?.accessToken).toBe(external);
  });

  it('returns the same object for none, a missing block, or nothing to resolve', () => {
    const none: AuthConfig = { type: 'none' };
    expect(resolveAuthVariables(none, resolve)).toBe(none);
    const types = [
      'bearer',
      'basic',
      'api-key',
      'oauth2',
      'digest',
      'aws-signature',
      'oauth1',
      'ntlm',
      'wsse',
    ] as const;
    for (const type of types) {
      const bare: AuthConfig = { type };
      expect(resolveAuthVariables(bare, resolve)).toBe(bare);
    }
    const plain: AuthConfig = { type: 'digest', digest: { username: 'u', password: 'p' } };
    expect(resolveAuthVariables(plain, resolve)).toBe(plain);
  });

  it('resolves digest username and password', () => {
    expect(
      resolveAuthVariables(
        { type: 'digest', digest: { username: '{{v}}', password: 'p{{v}}' } },
        resolve
      )
    ).toEqual({ type: 'digest', digest: { username: 'X', password: 'pX' } });
  });

  it('resolves every AWS SigV4 field', () => {
    expect(
      resolveAuthVariables(
        {
          type: 'aws-signature',
          awsSignature: {
            accessKey: '{{v}}',
            secretKey: '{{v}}',
            region: '{{v}}',
            service: 'a{{v}}',
          },
        },
        resolve
      )
    ).toEqual({
      type: 'aws-signature',
      awsSignature: { accessKey: 'X', secretKey: 'X', region: 'X', service: 'aX' },
    });
  });

  it('resolves OAuth1 text and secret fields, leaving signatureMethod/flags alone', () => {
    const out = resolveAuthVariables(
      {
        type: 'oauth1',
        oauth1: {
          consumerKey: '{{v}}',
          consumerSecret: { kind: 'inline', value: '{{v}}' },
          accessToken: '{{v}}',
          accessTokenSecret: handle,
          signatureMethod: 'HMAC-SHA256',
          realm: '{{v}}',
          addParamsToBody: true,
        },
      },
      resolve
    );
    expect(out.oauth1).toEqual({
      consumerKey: 'X',
      consumerSecret: { kind: 'inline', value: 'X' },
      accessToken: 'X',
      accessTokenSecret: handle,
      signatureMethod: 'HMAC-SHA256',
      realm: 'X',
      addParamsToBody: true,
    });
    expect(out.oauth1?.accessTokenSecret).toBe(handle);
  });

  it('resolves NTLM and WSSE credentials', () => {
    expect(
      resolveAuthVariables(
        {
          type: 'ntlm',
          ntlm: { username: '{{v}}', password: '{{v}}', domain: '{{v}}', workstation: 'w' },
        },
        resolve
      ).ntlm
    ).toEqual({ username: 'X', password: 'X', domain: 'X', workstation: 'w' });
    expect(
      resolveAuthVariables(
        {
          type: 'wsse',
          wsse: { username: '{{v}}', password: '{{v}}', passwordType: 'PasswordDigest' },
        },
        resolve
      ).wsse
    ).toEqual({ username: 'X', password: 'X', passwordType: 'PasswordDigest' });
  });

  it('resolves OAuth2 flow configuration but not enums or numbers', () => {
    const out = resolveAuthVariables(
      {
        type: 'oauth2',
        oauth2: {
          accessToken: 't',
          refreshToken: '{{v}}',
          clientId: '{{v}}',
          clientSecret: handle,
          tokenUrl: 'https://{{v}}/token',
          scope: '{{v}}',
          grantType: 'client_credentials',
          expiresAt: 5,
        },
      },
      resolve
    );
    expect(out.oauth2).toEqual({
      accessToken: 't',
      refreshToken: 'X',
      clientId: 'X',
      clientSecret: handle,
      tokenUrl: 'https://X/token',
      scope: 'X',
      grantType: 'client_credentials',
      expiresAt: 5,
    });
  });

  it('never mutates the input', () => {
    const input: AuthConfig = {
      type: 'wsse',
      wsse: { username: '{{v}}', password: { kind: 'inline', value: '{{v}}' } },
    };
    const snapshot = structuredClone(input);
    resolveAuthVariables(input, resolve);
    expect(input).toEqual(snapshot);
  });
});
