import { describe, expect, it } from 'vitest';
import { KAFKA_SECRET_SENTINEL, redactRegistry } from '../useKafkaStore';

describe('redactRegistry', () => {
  it('never persists plaintext Basic passwords or inline bearer tokens', () => {
    expect(
      redactRegistry({
        url: 'https://r.test',
        auth: { username: 'u', password: 'p' },
      })
    ).toEqual({ url: 'https://r.test', auth: { username: 'u', password: KAFKA_SECRET_SENTINEL } });
    expect(
      redactRegistry({ url: 'https://r.test', authType: 'bearer', bearerToken: 'plain' })
    ).toEqual({ url: 'https://r.test', authType: 'bearer', bearerToken: KAFKA_SECRET_SENTINEL });
    expect(
      redactRegistry({
        url: 'https://r.test',
        authType: 'bearer',
        bearerToken: { kind: 'inline', value: 'inline' },
      }).bearerToken
    ).toBe(KAFKA_SECRET_SENTINEL);
  });

  it('keeps handle / external references and drops empty tokens', () => {
    const handle = { kind: 'handle' as const, id: 'abc', label: 'reg' };
    expect(redactRegistry({ url: 'u', authType: 'bearer', bearerToken: handle }).bearerToken).toBe(
      handle
    );
    const external = {
      kind: 'external' as const,
      provider: 'azure-key-vault' as const,
      profileId: 'p',
      secretId: 's',
    };
    expect(
      redactRegistry({ url: 'u', authType: 'bearer', bearerToken: external }).bearerToken
    ).toBe(external);
    expect(redactRegistry({ url: 'u', authType: 'bearer', bearerToken: '' })).toEqual({
      url: 'u',
      authType: 'bearer',
    });
  });
});
