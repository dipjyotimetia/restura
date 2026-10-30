import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kafkaSecretKey, resolveRegistry } from '@/features/kafka/lib/kafkaManager';
import {
  applyKafkaPreset,
  copyKafkaPresetSecrets,
  kafkaPresetFromConnection,
  kafkaPresetSecretScope,
  readKafkaPresetSecrets,
  reapKafkaPresetSecrets,
  restoreKafkaPresetSecrets,
  storeKafkaPresetSecrets,
} from '@/features/kafka/lib/kafkaPreset';
import { KAFKA_SECRET_SENTINEL, useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import { brokerSecretHandleId, brokerSecretRef } from '@/lib/shared/broker-secrets';
import {
  getKafkaProduceDraft,
  getMqttComposerDraft,
  getPendingSecret,
  setKafkaProduceDraft,
  setPendingSecret,
} from '@/lib/shared/streaming/composerDrafts';
import { kafkaRequestSchema } from '@/lib/shared/validations';
import { createFakeSecretsApi } from '../../../../../tests/helpers/fakeSecretsApi';

const vault = vi.hoisted(() => new Map<string, string>());
vi.mock('@/lib/shared/secure-storage', () => ({
  secureStorage: {
    get: (key: string) => vault.get(key) ?? null,
    getAsync: async (key: string) => vault.get(key) ?? null,
    set: (key: string, value: string) => vault.set(key, value),
    remove: (key: string) => vault.delete(key),
  },
}));

// The main-process handle store, behind `window.electron.secrets` (SEC-K3).
let secrets = createFakeSecretsApi();
const handleOf = (key: string) => brokerSecretHandleId(key);
const stash = (key: string, value: string) => secrets.records.set(handleOf(key), { value });
const held = (key: string) => secrets.records.get(handleOf(key))?.value;
const isHeld = (key: string) => secrets.records.has(handleOf(key));

beforeEach(() => {
  secrets = createFakeSecretsApi();
  Object.defineProperty(window, 'electron', {
    value: { secrets: secrets.api },
    configurable: true,
  });
});
afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
});

function makeConnection(): string {
  const store = useKafkaStore.getState();
  const id = store.createConnection({ bootstrapBrokers: ['{{host}}:9092'] });
  store.updateConnection(id, {
    defaultTopic: 'orders.{{env}}',
    acks: -1,
    compression: 'gzip',
    idempotent: true,
    transactionalId: 'tx',
    registry: { url: 'https://reg', auth: { username: 'ru', password: KAFKA_SECRET_SENTINEL } },
  });
  store.updateAuth(id, {
    securityProtocol: 'SASL_SSL',
    sasl: { mechanism: 'SCRAM-SHA-256', username: 'alice', password: KAFKA_SECRET_SENTINEL },
    tls: { caPath: '/ca.pem', passphrase: KAFKA_SECRET_SENTINEL, rejectUnauthorized: false },
  });
  store.updateConsumer(id, { groupId: 'g1', topics: ['orders'], mode: 'earliest' });
  return id;
}

describe('kafka collection presets (#984)', () => {
  beforeEach(() => {
    vault.clear();
    useKafkaStore.setState({ connections: {}, activeConnectionId: null, connectionByTabId: {} });
  });
  afterEach(() => vi.restoreAllMocks());

  it('snapshots the connection and produce draft without any secret material', () => {
    const id = makeConnection();
    setKafkaProduceDraft(id, {
      key: 'k-{{n}}',
      keyEncoding: 'utf8',
      value: '{"a":1}',
      valueEncoding: 'json',
      headers: [{ id: 'h', key: 'trace', value: '{{trace}}', enabled: true }],
      partition: '2',
    });
    const conn = useKafkaStore.getState().connections[id]!;
    const preset = kafkaPresetFromConnection(conn, 'Orders', 'req-1');

    expect(preset).toEqual({
      id: 'req-1',
      name: 'Orders',
      type: 'kafka',
      connection: {
        bootstrapBrokers: ['{{host}}:9092'],
        clientId: conn.clientId,
        securityProtocol: 'SASL_SSL',
        sasl: { mechanism: 'SCRAM-SHA-256', username: 'alice' },
        tls: { caPath: '/ca.pem', rejectUnauthorized: false },
        registry: { url: 'https://reg', username: 'ru' },
        acks: -1,
        compression: 'gzip',
        idempotent: true,
        transactionalId: 'tx',
      },
      produce: {
        topic: 'orders.{{env}}',
        key: 'k-{{n}}',
        keyEncoding: 'utf8',
        value: '{"a":1}',
        valueEncoding: 'json',
        headers: [{ id: 'h', key: 'trace', value: '{{trace}}', enabled: true }],
        partition: 2,
      },
      consume: { groupId: 'g1', topics: ['orders'], mode: 'earliest' },
    });
    expect(JSON.stringify(preset)).not.toContain(KAFKA_SECRET_SENTINEL);
    expect(kafkaRequestSchema.safeParse(preset).success).toBe(true);
  });

  it('defaults the produce draft and keeps OAUTHBEARER extensions', () => {
    const id = useKafkaStore.getState().createConnection();
    useKafkaStore.getState().updateAuth(id, {
      securityProtocol: 'SASL_PLAINTEXT',
      sasl: { mechanism: 'OAUTHBEARER', token: KAFKA_SECRET_SENTINEL, extensions: { a: 'b' } },
    });
    const preset = kafkaPresetFromConnection(useKafkaStore.getState().connections[id]!, 'P');
    expect(preset.connection.sasl).toEqual({ mechanism: 'OAUTHBEARER', extensions: { a: 'b' } });
    expect(preset.produce).toMatchObject({ key: '', value: '', headers: [] });
    expect(preset.produce.partition).toBeUndefined();
    expect(getKafkaProduceDraft(null)).toBeUndefined();
    expect(getMqttComposerDraft(null)).toBeUndefined();
  });

  it('applies a preset onto a fresh connection and seeds the produce draft', () => {
    const source = makeConnection();
    setKafkaProduceDraft(source, {
      key: 'k',
      keyEncoding: 'base64',
      value: 'v',
      valueEncoding: 'utf8',
      headers: [],
      partition: '',
    });
    const preset = kafkaPresetFromConnection(useKafkaStore.getState().connections[source]!, 'P');

    const target = useKafkaStore.getState().createConnection();
    applyKafkaPreset(target, preset);
    const conn = useKafkaStore.getState().connections[target]!;
    expect(conn).toMatchObject({
      name: 'P',
      bootstrapBrokers: ['{{host}}:9092'],
      defaultTopic: 'orders.{{env}}',
      acks: -1,
      compression: 'gzip',
      idempotent: true,
      registry: { url: 'https://reg', auth: { username: 'ru' } },
      auth: {
        securityProtocol: 'SASL_SSL',
        sasl: { mechanism: 'SCRAM-SHA-256', username: 'alice', password: '' },
        tls: { caPath: '/ca.pem', rejectUnauthorized: false },
      },
      consumer: { groupId: 'g1', topics: ['orders'], mode: 'earliest', fromBeginning: true },
    });
    expect(getKafkaProduceDraft(target)).toMatchObject({ key: 'k', keyEncoding: 'base64' });
  });

  it('copies credentials into the preset scope and back, never into the preset', async () => {
    const source = makeConnection();
    stash(kafkaSecretKey(source, 'sasl-password'), 'pw');
    stash(kafkaSecretKey(source, 'tls-passphrase'), 'pp');
    stash(kafkaSecretKey(source, 'registry-password'), 'rp');
    const conn = useKafkaStore.getState().connections[source]!;
    const preset = kafkaPresetFromConnection(conn, 'P', 'req-9');
    stash(kafkaSecretKey(kafkaPresetSecretScope('req-9'), 'oauth-token'), 'stale');

    await storeKafkaPresetSecrets(conn, preset.id);
    const scope = kafkaPresetSecretScope('req-9');
    expect(held(kafkaSecretKey(scope, 'sasl-password'))).toBe('pw');
    expect(held(kafkaSecretKey(scope, 'tls-passphrase'))).toBe('pp');
    expect(held(kafkaSecretKey(scope, 'registry-password'))).toBe('rp');
    expect(isHeld(kafkaSecretKey(scope, 'oauth-token'))).toBe(false);
    expect(JSON.stringify(preset)).not.toMatch(/"pw"|"pp"|"rp"/);

    const target = useKafkaStore.getState().createConnection();
    applyKafkaPreset(target, preset);
    await restoreKafkaPresetSecrets(preset.id, target);
    const opened = useKafkaStore.getState().connections[target]!;
    expect(held(kafkaSecretKey(target, 'sasl-password'))).toBe('pw');
    expect(opened.auth.sasl).toMatchObject({ password: KAFKA_SECRET_SENTINEL });
    expect(opened.auth.tls?.passphrase).toBe(KAFKA_SECRET_SENTINEL);
    expect(opened.registry?.auth?.password).toBe(KAFKA_SECRET_SENTINEL);
    // Stored values move handle→handle in main; nothing lands in renderer storage.
    expect(secrets.api.copy).toHaveBeenCalled();
    expect([...vault.values()]).toEqual([]);
  });

  it('restores an OAUTHBEARER token and leaves a credential-less connection untouched', async () => {
    const target = useKafkaStore.getState().createConnection();
    applyKafkaPreset(target, {
      id: 'r',
      name: 'O',
      type: 'kafka',
      connection: {
        bootstrapBrokers: [],
        clientId: '',
        securityProtocol: 'SASL_PLAINTEXT',
        sasl: { mechanism: 'OAUTHBEARER' },
        acks: 1,
        compression: 'none',
        idempotent: false,
      },
      produce: {
        topic: '',
        key: '',
        keyEncoding: 'utf8',
        value: '',
        valueEncoding: 'utf8',
        headers: [],
        partition: 1,
      },
      consume: { groupId: '', topics: [], mode: 'committed' },
    });
    const before = useKafkaStore.getState().connections[target]!;
    expect(before.clientId).toBe(`restura-${target.slice(0, 8)}`);
    expect(getKafkaProduceDraft(target)?.partition).toBe('1');

    await restoreKafkaPresetSecrets('r', target);
    expect(useKafkaStore.getState().connections[target]!.auth).toEqual(before.auth);

    stash(kafkaSecretKey(kafkaPresetSecretScope('r'), 'oauth-token'), 'tok');
    await restoreKafkaPresetSecrets('r', target);
    expect(useKafkaStore.getState().connections[target]!.auth.sasl).toMatchObject({
      mechanism: 'OAUTHBEARER',
      token: KAFKA_SECRET_SENTINEL,
    });
  });
});

describe('kafka preset optional fields', () => {
  beforeEach(() => {
    useKafkaStore.setState({ connections: {}, activeConnectionId: null, connectionByTabId: {} });
  });

  it('omits unset TLS paths, registry username and transactional id', () => {
    const id = useKafkaStore.getState().createConnection();
    useKafkaStore.getState().updateConnection(id, { registry: { url: 'https://reg' } });
    useKafkaStore.getState().updateAuth(id, {
      securityProtocol: 'SSL',
      tls: { rejectUnauthorized: true },
    });
    const preset = kafkaPresetFromConnection(useKafkaStore.getState().connections[id]!, 'P');
    expect(preset.connection.tls).toEqual({ rejectUnauthorized: true });
    expect(preset.connection.registry).toEqual({ url: 'https://reg' });
    expect(preset.connection).not.toHaveProperty('transactionalId');
    expect(preset.connection).not.toHaveProperty('sasl');

    const target = useKafkaStore.getState().createConnection();
    const groupBefore = useKafkaStore.getState().connections[target]!.consumer.groupId;
    applyKafkaPreset(target, { ...preset, consume: { ...preset.consume, groupId: '' } });
    const conn = useKafkaStore.getState().connections[target]!;
    expect(conn.registry).toEqual({ url: 'https://reg' });
    expect(conn.consumer.groupId).toBe(groupBefore);
  });

  it('drops an invalid partition draft', () => {
    const id = useKafkaStore.getState().createConnection();
    setKafkaProduceDraft(id, {
      key: '',
      keyEncoding: 'utf8',
      value: '',
      valueEncoding: 'utf8',
      headers: [],
      partition: '-3',
    });
    const preset = kafkaPresetFromConnection(useKafkaStore.getState().connections[id]!, 'P');
    expect(preset.produce.partition).toBeUndefined();
    expect(getKafkaProduceDraft(null)).toBeUndefined();
    expect(getMqttComposerDraft(null)).toBeUndefined();
  });
});

describe('kafka preset credential lifecycle (#984 review)', () => {
  beforeEach(() => {
    vault.clear();
    useKafkaStore.setState({ connections: {}, activeConnectionId: null, connectionByTabId: {} });
  });

  it('saves credentials typed before connecting and plaintext field values', async () => {
    const id = useKafkaStore.getState().createConnection();
    useKafkaStore.getState().updateAuth(id, {
      securityProtocol: 'SASL_SSL',
      sasl: { mechanism: 'PLAIN', username: 'u', password: '' },
      tls: { passphrase: 'plain-pp' },
    });
    setPendingSecret(kafkaSecretKey(id, 'sasl-password'), 'typed-pw');
    await storeKafkaPresetSecrets(useKafkaStore.getState().connections[id]!, 'req-p');
    const scope = kafkaPresetSecretScope('req-p');
    expect(held(kafkaSecretKey(scope, 'sasl-password'))).toBe('typed-pw');
    expect(held(kafkaSecretKey(scope, 'tls-passphrase'))).toBe('plain-pp');
    expect(isHeld(kafkaSecretKey(scope, 'registry-password'))).toBe(false);
  });

  it('reaps and copies a preset scope', async () => {
    stash(kafkaSecretKey(kafkaPresetSecretScope('a'), 'oauth-token'), 'tok');
    await copyKafkaPresetSecrets('a', 'b');
    expect(held(kafkaSecretKey(kafkaPresetSecretScope('b'), 'oauth-token'))).toBe('tok');
    // Presence flags only — the plaintext never comes back to the renderer.
    expect(await readKafkaPresetSecrets('b')).toEqual({ 'oauth-token': true });
    expect(secrets.api.copy).toHaveBeenCalled();
    await reapKafkaPresetSecrets('a');
    expect(await readKafkaPresetSecrets('a')).toEqual({});
  });

  it('migrates a legacy secureStorage preset credential into its handle once', async () => {
    const key = kafkaSecretKey(kafkaPresetSecretScope('old'), 'sasl-password');
    vault.set(key, 'legacy-pw');
    expect(await readKafkaPresetSecrets('old')).toEqual({ 'sasl-password': true });
    expect(held(key)).toBe('legacy-pw');
    expect(vault.has(key)).toBe(false);
  });

  it('clears drafts and pending credentials when the connection goes away', () => {
    const id = useKafkaStore.getState().createConnection();
    setKafkaProduceDraft(id, {
      key: '',
      keyEncoding: 'utf8',
      value: 'v',
      valueEncoding: 'utf8',
      headers: [],
      partition: '',
    });
    setPendingSecret(kafkaSecretKey(id, 'sasl-password'), 'pw');
    useKafkaStore.getState().removeConnection(id);
    expect(getKafkaProduceDraft(id)).toBeUndefined();
    expect(getPendingSecret(kafkaSecretKey(id, 'sasl-password'))).toBeUndefined();
  });

  describe('Schema Registry bearer auth', () => {
    function bearerConnection(bearerToken: unknown): string {
      const store = useKafkaStore.getState();
      const id = store.createConnection({ bootstrapBrokers: ['b:9092'] });
      store.updateConnection(id, {
        registry: { url: 'https://reg', authType: 'bearer', bearerToken: bearerToken as never },
      });
      return id;
    }

    it('round-trips an inline bearer token into a bearer registry request', async () => {
      const source = bearerConnection('tok');
      const conn = useKafkaStore.getState().connections[source]!;
      const preset = kafkaPresetFromConnection(conn, 'B', 'req-b');
      expect(preset.connection.registry).toEqual({ url: 'https://reg', authType: 'bearer' });
      expect(JSON.stringify(preset)).not.toContain('tok"');
      expect(kafkaRequestSchema.safeParse(preset).success).toBe(true);

      await storeKafkaPresetSecrets(conn, 'req-b');
      expect(held(kafkaSecretKey(kafkaPresetSecretScope('req-b'), 'registry-token'))).toBe('tok');

      const target = useKafkaStore.getState().createConnection();
      applyKafkaPreset(target, preset);
      await restoreKafkaPresetSecrets('req-b', target);
      const opened = useKafkaStore.getState().connections[target]!;
      expect(opened.registry).toMatchObject({
        authType: 'bearer',
        bearerToken: KAFKA_SECRET_SENTINEL,
      });
      expect(held(kafkaSecretKey(target, 'registry-token'))).toBe('tok');
      const resolved = await resolveRegistry(target, opened.registry);
      expect(resolved?.auth).toEqual({
        type: 'bearer',
        token: brokerSecretRef(kafkaSecretKey(target, 'registry-token')),
      });
    });

    it('keeps authType for a handle-backed token and surfaces the re-enter error', async () => {
      const source = bearerConnection({ kind: 'handle', id: 'h-1' });
      const conn = useKafkaStore.getState().connections[source]!;
      const preset = kafkaPresetFromConnection(conn, 'H', 'req-h');
      expect(preset.connection.registry?.authType).toBe('bearer');
      await storeKafkaPresetSecrets(conn, 'req-h');
      expect(isHeld(kafkaSecretKey(kafkaPresetSecretScope('req-h'), 'registry-token'))).toBe(false);
      const target = useKafkaStore.getState().createConnection();
      applyKafkaPreset(target, preset);
      await restoreKafkaPresetSecrets('req-h', target);
      const opened = useKafkaStore.getState().connections[target]!;
      await expect(resolveRegistry(target, opened.registry)).rejects.toThrow(/re-enter/);
    });

    it('captures a token typed but not yet connected (pending draft)', async () => {
      const source = bearerConnection(undefined);
      setPendingSecret(kafkaSecretKey(source, 'registry-token'), 'typed');
      await storeKafkaPresetSecrets(useKafkaStore.getState().connections[source]!, 'req-p');
      expect(held(kafkaSecretKey(kafkaPresetSecretScope('req-p'), 'registry-token'))).toBe('typed');
    });

    it('an old preset without authType still behaves as basic/none', async () => {
      const source = makeConnection();
      const preset = kafkaPresetFromConnection(useKafkaStore.getState().connections[source]!, 'P');
      expect(preset.connection.registry).toEqual({ url: 'https://reg', username: 'ru' });
      expect(kafkaRequestSchema.safeParse(preset).success).toBe(true);
      const target = useKafkaStore.getState().createConnection();
      applyKafkaPreset(target, preset);
      const reg = useKafkaStore.getState().connections[target]!.registry!;
      expect(reg.authType).toBeUndefined();
      const resolved = await resolveRegistry(target, reg);
      expect(resolved?.auth).toEqual({ username: 'ru' });
    });
  });
});
