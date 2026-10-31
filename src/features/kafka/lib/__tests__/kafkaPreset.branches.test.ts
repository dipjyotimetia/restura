import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kafkaSecretKey } from '@/features/kafka/lib/kafkaManager';
import {
  applyKafkaPreset,
  applyKafkaPresetSecrets,
  kafkaPresetFromConnection,
  kafkaPresetSecretScope,
  readKafkaPresetSecrets,
  storeKafkaPresetSecrets,
} from '@/features/kafka/lib/kafkaPreset';
import { KAFKA_SECRET_SENTINEL, useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import { brokerSecretHandleId, brokerSecretRef } from '@/lib/shared/broker-secrets';
import { setPendingSecret } from '@/lib/shared/streaming/composerDrafts';
import type { KafkaRequest } from '@/types';
import { createFakeSecretsApi } from '../../../../../tests/helpers/fakeSecretsApi';

let secrets = createFakeSecretsApi();
const stash = (key: string, value: string) =>
  secrets.records.set(brokerSecretHandleId(key), { value });
const held = (key: string) => secrets.records.get(brokerSecretHandleId(key))?.value;

beforeEach(() => {
  secrets = createFakeSecretsApi();
  Object.defineProperty(window, 'electron', {
    value: { secrets: secrets.api },
    configurable: true,
  });
  useKafkaStore.setState({ connections: {}, activeConnectionId: null, connectionByTabId: {} });
});
afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
});

function preset(over: Partial<KafkaRequest['connection']> = {}, consume = {}): KafkaRequest {
  return {
    id: 'rq',
    name: 'P',
    type: 'kafka',
    connection: {
      bootstrapBrokers: ['b:9092'],
      clientId: 'cid',
      securityProtocol: 'PLAINTEXT',
      acks: 1,
      compression: 'none',
      idempotent: false,
      ...over,
    },
    produce: {
      topic: 't',
      key: '',
      keyEncoding: 'utf8',
      value: '',
      valueEncoding: 'utf8',
      headers: [],
    },
    consume: { groupId: '', topics: [], mode: 'committed', ...consume },
  } as unknown as KafkaRequest;
}

describe('kafkaPreset branches', () => {
  it('snapshots a plain connection without sasl, tls, registry or transactional id', () => {
    const id = useKafkaStore.getState().createConnection();
    const out = kafkaPresetFromConnection(useKafkaStore.getState().connections[id]!, 'Plain', 'r1');
    expect(out.connection).not.toHaveProperty('sasl');
    expect(out.connection).not.toHaveProperty('tls');
    expect(out.connection).not.toHaveProperty('registry');
    expect(out.connection).not.toHaveProperty('transactionalId');
  });

  it('keeps only the TLS fields that are set, and registry auth type without username', () => {
    const id = useKafkaStore.getState().createConnection();
    const store = useKafkaStore.getState();
    store.updateAuth(id, { securityProtocol: 'SSL', tls: { certPath: '/c', keyPath: '/k' } });
    store.updateConnection(id, { registry: { url: 'https://r', authType: 'bearer' } });
    const out = kafkaPresetFromConnection(useKafkaStore.getState().connections[id]!, 'T', 'r2');
    expect(out.connection.tls).toEqual({ certPath: '/c', keyPath: '/k' });
    expect(out.connection.registry).toEqual({ url: 'https://r', authType: 'bearer' });
  });

  it('applies a preset with bearer registry, username-less SCRAM, TLS, and no consumer group', () => {
    const id = useKafkaStore.getState().createConnection();
    const groupBefore = useKafkaStore.getState().connections[id]!.consumer.groupId;
    applyKafkaPreset(
      id,
      preset({
        securityProtocol: 'SASL_SSL',
        sasl: { mechanism: 'SCRAM-SHA-512' },
        tls: { caPath: '/ca' },
        registry: { url: 'https://r', authType: 'bearer' },
      })
    );
    const conn = useKafkaStore.getState().connections[id]!;
    expect(conn.auth.sasl).toEqual({ mechanism: 'SCRAM-SHA-512', username: '', password: '' });
    expect(conn.auth.tls).toEqual({ caPath: '/ca' });
    expect(conn.registry).toEqual({ url: 'https://r', authType: 'bearer' });
    expect(conn.consumer.groupId).toBe(groupBefore);
    expect(conn.consumer.fromBeginning).toBe(false);
  });

  it('applies OAUTHBEARER extensions and a registry username, and earliest implies fromBeginning', () => {
    const id = useKafkaStore.getState().createConnection();
    applyKafkaPreset(
      id,
      preset(
        {
          securityProtocol: 'SASL_PLAINTEXT',
          sasl: { mechanism: 'OAUTHBEARER', extensions: { a: 'b' } },
          registry: { url: 'https://r', username: 'u' },
        },
        { groupId: 'gg', topics: ['x'], mode: 'earliest' }
      )
    );
    const conn = useKafkaStore.getState().connections[id]!;
    expect(conn.auth.sasl).toEqual({ mechanism: 'OAUTHBEARER', token: '', extensions: { a: 'b' } });
    expect(conn.registry).toEqual({ url: 'https://r', auth: { username: 'u' } });
    expect(conn.consumer).toMatchObject({ groupId: 'gg', fromBeginning: true });
  });

  it('stores pending OAuth/registry-token drafts and ignores handle-backed bearer tokens', async () => {
    const id = useKafkaStore.getState().createConnection();
    const store = useKafkaStore.getState();
    store.updateAuth(id, {
      securityProtocol: 'SASL_PLAINTEXT',
      sasl: { mechanism: 'OAUTHBEARER', token: KAFKA_SECRET_SENTINEL },
    });
    store.updateConnection(id, {
      registry: { url: 'https://r', authType: 'bearer', bearerToken: 'inline-token' },
    });
    stash(kafkaSecretKey(id, 'oauth-token'), 'stored-oauth');
    setPendingSecret(kafkaSecretKey(id, 'tls-passphrase'), 'typed-pp');
    await storeKafkaPresetSecrets(useKafkaStore.getState().connections[id]!, 'p1');
    const scope = kafkaPresetSecretScope('p1');
    expect(held(kafkaSecretKey(scope, 'oauth-token'))).toBe('stored-oauth');
    expect(held(kafkaSecretKey(scope, 'registry-token'))).toBe('inline-token');
    expect(held(kafkaSecretKey(scope, 'tls-passphrase'))).toBe('typed-pp');

    useKafkaStore.getState().updateConnection(id, {
      registry: { url: 'https://r', authType: 'bearer', bearerToken: brokerSecretRef('k') },
    });
    await storeKafkaPresetSecrets(useKafkaStore.getState().connections[id]!, 'p1');
    expect(held(kafkaSecretKey(scope, 'registry-token'))).toBeUndefined();
    expect(await readKafkaPresetSecrets('p1')).toMatchObject({ 'oauth-token': true });
  });

  it('applies copied registry token and ignores flags for fields that did not copy', async () => {
    const id = useKafkaStore.getState().createConnection();
    useKafkaStore.getState().updateConnection(id, {
      registry: { url: 'https://r', authType: 'bearer' },
    });
    const scope = kafkaPresetSecretScope('p2');
    stash(kafkaSecretKey(scope, 'registry-token'), 'bt');
    await applyKafkaPresetSecrets('p2', id, { 'registry-token': true, 'sasl-password': true });
    expect(useKafkaStore.getState().connections[id]!.registry?.bearerToken).toBe(
      KAFKA_SECRET_SENTINEL
    );

    // Nothing copied at all (source handles missing): connection left alone.
    const other = useKafkaStore.getState().createConnection();
    const before = useKafkaStore.getState().connections[other]!.auth;
    await applyKafkaPresetSecrets('missing', other, { 'sasl-password': true });
    expect(useKafkaStore.getState().connections[other]!.auth).toEqual(before);

    // The target connection no longer exists.
    await expect(
      applyKafkaPresetSecrets('p2', 'gone', { 'registry-token': true })
    ).resolves.toBeUndefined();
  });

  it('applies a copied registry password onto a registry without prior auth', async () => {
    const id = useKafkaStore.getState().createConnection();
    useKafkaStore.getState().updateConnection(id, { registry: { url: 'https://r' } });
    stash(kafkaSecretKey(kafkaPresetSecretScope('p3'), 'registry-password'), 'rp');
    await applyKafkaPresetSecrets('p3', id, { 'registry-password': true });
    expect(useKafkaStore.getState().connections[id]!.registry?.auth).toEqual({
      password: KAFKA_SECRET_SENTINEL,
    });
  });
});
