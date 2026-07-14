import { describe, expect, it, vi } from 'vitest';
import { migrateAuthConfigToSecretRef } from '../secretRef-migrations';

describe('migrateAuthConfigToSecretRef', () => {
  it('returns undefined for non-object input', () => {
    expect(migrateAuthConfigToSecretRef(undefined)).toBeUndefined();
    expect(migrateAuthConfigToSecretRef(null)).toBeUndefined();
    expect(migrateAuthConfigToSecretRef('not an object')).toBeUndefined();
  });

  it('preserves type and non-sensitive metadata', () => {
    const out = migrateAuthConfigToSecretRef({
      type: 'aws-signature',
      awsSignature: { accessKey: 'AKIA', secretKey: 'plain', region: 'us-east-1', service: 's3' },
    });
    expect(out?.type).toBe('aws-signature');
    expect(out?.awsSignature?.accessKey).toBe('AKIA');
    expect(out?.awsSignature?.region).toBe('us-east-1');
    expect(out?.awsSignature?.service).toBe('s3');
  });

  it('wraps plain string passwords as inline SecretValue', () => {
    const out = migrateAuthConfigToSecretRef({
      type: 'basic',
      basic: { username: 'u', password: 'hunter2' },
    });
    expect(out?.basic?.username).toBe('u');
    expect(out?.basic?.password).toEqual({ kind: 'inline', value: 'hunter2' });
  });

  it('wraps bearer.token', () => {
    const out = migrateAuthConfigToSecretRef({ type: 'bearer', bearer: { token: 'abc' } });
    expect(out?.bearer?.token).toEqual({ kind: 'inline', value: 'abc' });
  });

  it('wraps apiKey.value but leaves apiKey.key plain', () => {
    const out = migrateAuthConfigToSecretRef({
      type: 'api-key',
      apiKey: { key: 'X-Api-Key', value: 's3cret', in: 'header' },
    });
    expect(out?.apiKey?.key).toBe('X-Api-Key');
    expect(out?.apiKey?.value).toEqual({ kind: 'inline', value: 's3cret' });
    expect(out?.apiKey?.in).toBe('header');
  });

  it('wraps all sensitive oauth2 fields and keeps non-sensitive ones', () => {
    const out = migrateAuthConfigToSecretRef({
      type: 'oauth2',
      oauth2: {
        accessToken: 'at',
        refreshToken: 'rt',
        clientSecret: 'cs',
        password: 'pw',
        clientId: 'cid',
        tokenUrl: 'https://example.com/token',
        grantType: 'authorization_code',
      },
    });
    expect(out?.oauth2?.accessToken).toEqual({ kind: 'inline', value: 'at' });
    expect(out?.oauth2?.refreshToken).toEqual({ kind: 'inline', value: 'rt' });
    expect(out?.oauth2?.clientSecret).toEqual({ kind: 'inline', value: 'cs' });
    expect(out?.oauth2?.password).toEqual({ kind: 'inline', value: 'pw' });
    expect(out?.oauth2?.clientId).toBe('cid');
    expect(out?.oauth2?.tokenUrl).toBe('https://example.com/token');
    expect(out?.oauth2?.grantType).toBe('authorization_code');
  });

  it('wraps oauth1.consumerSecret and oauth1.accessTokenSecret; keeps consumerKey plain', () => {
    const out = migrateAuthConfigToSecretRef({
      type: 'oauth1',
      oauth1: {
        consumerKey: 'ck',
        consumerSecret: 'cs',
        accessToken: 'at',
        accessTokenSecret: 'ats',
        realm: 'r',
      },
    });
    expect(out?.oauth1?.consumerKey).toBe('ck');
    expect(out?.oauth1?.consumerSecret).toEqual({ kind: 'inline', value: 'cs' });
    expect(out?.oauth1?.accessToken).toEqual({ kind: 'inline', value: 'at' });
    expect(out?.oauth1?.accessTokenSecret).toEqual({ kind: 'inline', value: 'ats' });
    expect(out?.oauth1?.realm).toBe('r');
  });

  it('wraps awsSignature.secretKey, keeps accessKey/region/service plain', () => {
    const out = migrateAuthConfigToSecretRef({
      type: 'aws-signature',
      awsSignature: { accessKey: 'AKIA', secretKey: 'sk', region: 'us', service: 's3' },
    });
    expect(out?.awsSignature?.secretKey).toEqual({ kind: 'inline', value: 'sk' });
    expect(out?.awsSignature?.accessKey).toBe('AKIA');
  });

  it('wraps digest/ntlm/wsse passwords; usernames stay plain', () => {
    const digest = migrateAuthConfigToSecretRef({
      type: 'digest',
      digest: { username: 'u', password: 'pw' },
    });
    expect(digest?.digest?.password).toEqual({ kind: 'inline', value: 'pw' });
    expect(digest?.digest?.username).toBe('u');

    const ntlm = migrateAuthConfigToSecretRef({
      type: 'ntlm',
      ntlm: { username: 'u', password: 'pw', domain: 'D' },
    });
    expect(ntlm?.ntlm?.password).toEqual({ kind: 'inline', value: 'pw' });
    expect(ntlm?.ntlm?.username).toBe('u');
    expect(ntlm?.ntlm?.domain).toBe('D');

    const wsse = migrateAuthConfigToSecretRef({
      type: 'wsse',
      wsse: { username: 'u', password: 'pw', passwordType: 'PasswordDigest' },
    });
    expect(wsse?.wsse?.password).toEqual({ kind: 'inline', value: 'pw' });
    expect(wsse?.wsse?.passwordType).toBe('PasswordDigest');
  });

  it('is idempotent — SecretRefs survive a second migration', () => {
    const once = migrateAuthConfigToSecretRef({ type: 'bearer', bearer: { token: 'abc' } });
    const twice = migrateAuthConfigToSecretRef(once);
    expect(twice?.bearer?.token).toEqual({ kind: 'inline', value: 'abc' });
  });

  it('preserves existing handle SecretRefs unchanged', () => {
    const out = migrateAuthConfigToSecretRef({
      type: 'bearer',
      bearer: { token: { kind: 'handle', id: 'h1', label: 'prod' } },
    });
    expect(out?.bearer?.token).toEqual({ kind: 'handle', id: 'h1', label: 'prod' });
  });

  it('handles missing sub-objects (no-op for unset method blocks)', () => {
    const out = migrateAuthConfigToSecretRef({ type: 'none' });
    expect(out?.type).toBe('none');
    expect(out?.basic).toBeUndefined();
    expect(out?.bearer).toBeUndefined();
  });

  it('works as a recursive walker over a nested collection tree (store migration shape)', () => {
    // Simulates how useCollectionStore's v2→v3 migrate fn applies the helper
    // across folders + requests. Validates the helper handles arbitrary nesting.
    type Item = {
      type: 'folder' | 'request';
      items?: Item[];
      request?: { auth?: unknown };
    };
    const walk = (item: Item): Item => {
      if (item.type === 'folder') {
        return { ...item, items: item.items?.map(walk) ?? [] };
      }
      if (item.request && 'auth' in item.request) {
        const auth = migrateAuthConfigToSecretRef(item.request.auth);
        if (auth) return { ...item, request: { ...item.request, auth } };
      }
      return item;
    };
    const tree: Item = {
      type: 'folder',
      items: [
        {
          type: 'folder',
          items: [
            {
              type: 'request',
              request: { auth: { type: 'bearer', bearer: { token: 'inner-token' } } },
            },
          ],
        },
        {
          type: 'request',
          request: { auth: { type: 'basic', basic: { username: 'u', password: 'p' } } },
        },
      ],
    };
    const migrated = walk(tree);
    const innerReq = migrated.items![0]!.items![0]!.request as {
      auth: { bearer: { token: unknown } };
    };
    expect(innerReq.auth.bearer.token).toEqual({ kind: 'inline', value: 'inner-token' });
    const outerReq = migrated.items![1]!.request as { auth: { basic: { password: unknown } } };
    expect(outerReq.auth.basic.password).toEqual({ kind: 'inline', value: 'p' });
  });
});

describe('convertInlineSecretsToHandles — IPC failure degradation', () => {
  it('keeps the inline value when secrets.store rejects (e.g. rate limit) instead of aborting', async () => {
    vi.resetModules();
    // First store call succeeds, second rejects mid-conversion — the helper
    // must keep converting field-by-field, not throw and abort the caller's
    // Promise.all (which would orphan already-stored handles).
    const store = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, id: 'handle-1' })
      .mockRejectedValueOnce(new Error('Rate limit exceeded'));
    vi.doMock('../platform', () => ({
      isElectron: () => true,
      getElectronAPI: () => ({ secrets: { store } }),
    }));
    const { convertInlineSecretsToHandles } = await import('../secretRef-migrations');

    const auth = {
      type: 'oauth2' as const,
      oauth2: { accessToken: 'tok-a', clientSecret: 'sec-b' },
    };
    const result = await convertInlineSecretsToHandles(auth, 'col/req');

    expect(store).toHaveBeenCalledTimes(2);
    const oauth2 = result!.oauth2 as Record<string, unknown>;
    // First field converted to a handle…
    expect(oauth2.accessToken).toEqual({
      kind: 'handle',
      id: 'handle-1',
      label: 'col/req/oauth2.accessToken',
    });
    // …second kept inline after the rejected invoke (no throw, no data loss).
    expect(oauth2.clientSecret).toBe('sec-b');
    vi.doUnmock('../platform');
  });
});
