import { describe, expect, it, vi } from 'vitest';
import type { KafkaSasl } from '@/features/kafka/store/useKafkaStore';
import {
  kafkaSaslHandleIds,
  kafkaSaslPreflightError,
  persistKafkaSaslSecrets,
  type StoreSecretFn,
} from '../kafkaSaslSecrets';

function okStore(): ReturnType<typeof vi.fn<StoreSecretFn>> {
  let next = 0;
  return vi.fn<StoreSecretFn>(async (args) => ({ ok: true, id: args.id ?? `new-${++next}` }));
}

describe('persistKafkaSaslSecrets', () => {
  const cc: KafkaSasl = {
    mechanism: 'OAUTHBEARER',
    mode: 'client-credentials',
    tokenEndpoint: 'https://idp/token',
    clientId: 'c',
  };

  it('stores the OAuth client secret as a scoped, labelled handle', async () => {
    const store = okStore();
    const next = await persistKafkaSaslSecrets(cc, { oauthClientSecret: 's3cret' }, 'prod', store);
    expect(store).toHaveBeenCalledWith({
      value: 's3cret',
      label: 'Kafka prod / OAuth client secret',
      scope: 'kafka',
    });
    expect(next).toEqual({
      ...cc,
      clientSecret: { kind: 'handle', id: 'new-1', label: 'Kafka prod / OAuth client secret' },
    });
    expect(JSON.stringify(next)).not.toContain('s3cret');
  });

  it('updates an existing handle in place', async () => {
    const store = okStore();
    const existing = { kind: 'handle' as const, id: 'keep-me' };
    const next = await persistKafkaSaslSecrets(
      { ...cc, clientSecret: existing } as KafkaSasl,
      { oauthClientSecret: 'rotated' },
      'prod',
      store
    );
    expect(store).toHaveBeenCalledWith(expect.objectContaining({ id: 'keep-me' }));
    expect(next).toMatchObject({ clientSecret: { kind: 'handle', id: 'keep-me' } });
  });

  it('stores MSK IAM secret key and session token independently', async () => {
    const store = okStore();
    const msk: KafkaSasl = {
      mechanism: 'AWS_MSK_IAM',
      region: 'us-east-1',
      credentialSource: 'static',
      accessKeyId: 'AKIA',
    };
    const both = await persistKafkaSaslSecrets(
      msk,
      { awsSecretAccessKey: 'sk', awsSessionToken: 'st' },
      'msk',
      store
    );
    expect(both).toMatchObject({
      secretAccessKey: { kind: 'handle', id: 'new-1' },
      sessionToken: { kind: 'handle', id: 'new-2' },
    });
    const onlySession = await persistKafkaSaslSecrets(msk, { awsSessionToken: 'st' }, 'msk', store);
    expect(onlySession).toMatchObject({ sessionToken: { kind: 'handle' } });
    expect(onlySession).not.toHaveProperty('secretAccessKey');
  });

  it('returns the same object when there is nothing to store', async () => {
    const store = okStore();
    const plain: KafkaSasl = { mechanism: 'PLAIN', username: 'u', password: 'p' };
    expect(await persistKafkaSaslSecrets(plain, { oauthClientSecret: 'x' }, 'n', store)).toBe(
      plain
    );
    expect(await persistKafkaSaslSecrets(cc, {}, 'n', store)).toBe(cc);
    const msk: KafkaSasl = { mechanism: 'AWS_MSK_IAM', region: 'r', credentialSource: 'static' };
    expect(await persistKafkaSaslSecrets(msk, { awsSecretAccessKey: '' }, 'n', store)).toBe(msk);
    expect(store).not.toHaveBeenCalled();
  });

  it('fails closed when secure storage is unavailable or rejects the value', async () => {
    await expect(
      persistKafkaSaslSecrets(cc, { oauthClientSecret: 'x' }, 'n', undefined)
    ).rejects.toThrow('Secure secret storage is unavailable.');
    const failing = vi.fn<StoreSecretFn>(async () => ({ ok: false, error: 'keychain locked' }));
    await expect(
      persistKafkaSaslSecrets(cc, { oauthClientSecret: 'x' }, 'n', failing)
    ).rejects.toThrow('Failed to store Kafka n / OAuth client secret: keychain locked');
  });
});

describe('kafkaSaslHandleIds', () => {
  it('lists handles referenced by client-credentials and MSK IAM blocks only', () => {
    expect(kafkaSaslHandleIds(undefined)).toEqual([]);
    expect(kafkaSaslHandleIds({ mechanism: 'PLAIN', username: 'u', password: 'p' })).toEqual([]);
    expect(
      kafkaSaslHandleIds({
        mechanism: 'OAUTHBEARER',
        mode: 'client-credentials',
        tokenEndpoint: 't',
        clientId: 'c',
        clientSecret: { kind: 'handle', id: 'a' },
      })
    ).toEqual(['a']);
    expect(
      kafkaSaslHandleIds({
        mechanism: 'OAUTHBEARER',
        mode: 'client-credentials',
        tokenEndpoint: 't',
        clientId: 'c',
      })
    ).toEqual([]);
    expect(
      kafkaSaslHandleIds({
        mechanism: 'AWS_MSK_IAM',
        region: 'r',
        credentialSource: 'static',
        secretAccessKey: { kind: 'handle', id: 'b' },
        sessionToken: { kind: 'handle', id: 'c' },
      })
    ).toEqual(['b', 'c']);
  });
});

describe('kafkaSaslPreflightError', () => {
  const msk: KafkaSasl = {
    mechanism: 'AWS_MSK_IAM',
    region: 'us-east-1',
    credentialSource: 'profile',
  };
  const mskBroker = ['b-1.x.c2.kafka.us-east-1.amazonaws.com:9098'];

  it('passes non-MSK mechanisms and well-formed MSK configs', () => {
    expect(kafkaSaslPreflightError(undefined, 'PLAINTEXT', [])).toBeUndefined();
    expect(kafkaSaslPreflightError(msk, 'SASL_SSL', mskBroker)).toBeUndefined();
    expect(kafkaSaslPreflightError({ ...msk, region: '' }, 'SASL_SSL', ['x:1'])).toBeUndefined();
  });

  it('flags SASL_PLAINTEXT and non-MSK brokers unless opted out', () => {
    expect(kafkaSaslPreflightError(msk, 'SASL_PLAINTEXT', mskBroker)).toMatch(/SASL_SSL/);
    expect(kafkaSaslPreflightError(msk, 'SASL_SSL', ['evil:9098'])).toMatch(/evil:9098/);
    expect(
      kafkaSaslPreflightError({ ...msk, allowNonAwsBrokerHosts: true }, 'SASL_SSL', ['evil:9098'])
    ).toBeUndefined();
  });
});
