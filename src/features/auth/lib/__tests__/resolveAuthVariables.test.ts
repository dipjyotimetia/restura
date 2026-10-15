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

  it('returns the same object for other types or a missing block', () => {
    const digest: AuthConfig = { type: 'digest', digest: { username: '{{v}}', password: 'p' } };
    expect(resolveAuthVariables(digest, resolve)).toBe(digest);
    for (const type of ['bearer', 'basic', 'api-key', 'oauth2'] as const) {
      const bare: AuthConfig = { type };
      expect(resolveAuthVariables(bare, resolve)).toBe(bare);
    }
  });
});
