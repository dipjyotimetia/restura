import { describe, expect, it } from 'vitest';
import {
  KafkaConnectSchema,
  KafkaProduceSchema,
  KafkaRegistryGetSchemaSchema,
  KafkaRegistryListSubjectsSchema,
  KafkaRegistryListVersionsSchema,
} from '../ipc/ipc-validators';

const connect = (registry: unknown) =>
  KafkaConnectSchema.safeParse({
    connectionId: 'abc-123',
    clientId: 'restura-test',
    bootstrapBrokers: ['localhost:9092'],
    auth: { securityProtocol: 'PLAINTEXT' },
    registry,
  });

const produceValue = (value: unknown) =>
  KafkaProduceSchema.safeParse({
    connectionId: 'abc-123',
    acks: 1,
    record: { topic: 'orders', value },
  });

describe('Kafka Schema Registry IPC validators', () => {
  describe('registry auth', () => {
    it('normalises the legacy untyped Basic shape to type basic', () => {
      const result = connect({
        url: 'https://registry.example.test',
        auth: { username: 'u', password: 'p' },
      });
      expect(result.success).toBe(true);
      expect(result.data?.registry?.auth).toEqual({ type: 'basic', username: 'u', password: 'p' });
    });

    it('accepts typed Basic auth', () => {
      const result = connect({
        url: 'https://registry.example.test',
        auth: { type: 'basic', username: 'u' },
      });
      expect(result.data?.registry?.auth).toEqual({ type: 'basic', username: 'u' });
    });

    it.each([
      ['plaintext', 'tok'],
      ['inline', { kind: 'inline', value: 'tok' }],
      ['handle', { kind: 'handle', id: '7e1a6a8e-2a8b-4a43-9b5b-1f6f4f1f2c11' }],
    ])('accepts a bearer token as a %s SecretValue', (_label, token) => {
      const result = connect({
        url: 'https://registry.example.test',
        auth: { type: 'bearer', token },
      });
      expect(result.success).toBe(true);
      expect(result.data?.registry?.auth).toEqual({ type: 'bearer', token });
    });

    it.each([
      ['empty string', ''],
      ['empty inline', { kind: 'inline', value: '' }],
    ])('rejects a bearer token that is an %s', (_label, token) => {
      expect(
        connect({ url: 'https://registry.example.test', auth: { type: 'bearer', token } }).success
      ).toBe(false);
    });

    it('rejects credentials embedded in the registry URL', () => {
      expect(connect({ url: 'https://user:pw@registry.example.test' }).success).toBe(false);
      expect(connect({ url: 'https://registry.example.test/prefix' }).success).toBe(true);
    });

    it('rejects mixed or unknown auth fields', () => {
      expect(
        connect({ url: 'https://r.test', auth: { type: 'bearer', token: 't', password: 'p' } })
          .success
      ).toBe(false);
      expect(connect({ url: 'https://r.test', auth: { type: 'digest' } }).success).toBe(false);
      expect(connect({ url: 'https://r.test', auth: { token: 't' } }).success).toBe(false);
    });
  });

  describe('schema-encoded produce fields', () => {
    it('keeps accepting a numeric schemaId', () => {
      expect(produceValue({ encoding: 'schema', schemaId: 7, data: '{}' }).success).toBe(true);
    });

    it.each([3, 'latest'])('accepts subject + version %s', (version) => {
      const result = produceValue({
        encoding: 'schema',
        subject: 'orders-value',
        version,
        data: '{}',
      });
      expect(result.success).toBe(true);
    });

    it('accepts subject-based key fields too', () => {
      const result = KafkaProduceSchema.safeParse({
        connectionId: 'abc-123',
        acks: 1,
        record: {
          topic: 'orders',
          key: { encoding: 'schema', subject: 'orders-key', version: 'latest', data: '"k"' },
          value: { encoding: 'utf8', data: 'v' },
        },
      });
      expect(result.success).toBe(true);
    });

    it.each([
      ['both id and subject', { schemaId: 1, subject: 'orders-value', version: 1 }],
      ['neither id nor subject', {}],
      ['subject without version', { subject: 'orders-value' }],
      ['version without subject', { version: 'latest' }],
      ['non-positive version', { subject: 'orders-value', version: 0 }],
      ['unknown version keyword', { subject: 'orders-value', version: 'earliest' }],
      ['control characters in subject', { subject: 'orders\nvalue', version: 1 }],
      ['empty subject', { subject: '', version: 1 }],
      ['dot-segment subject', { subject: '..', version: 1 }],
      ['single-dot subject', { subject: '.', version: 1 }],
    ])('rejects %s', (_label, fields) => {
      expect(produceValue({ encoding: 'schema', data: '{}', ...fields }).success).toBe(false);
    });
  });

  describe('browse channels', () => {
    it('validates list subjects input strictly', () => {
      expect(KafkaRegistryListSubjectsSchema.safeParse({ connectionId: 'c1' }).success).toBe(true);
      expect(
        KafkaRegistryListSubjectsSchema.safeParse({ connectionId: 'c1', extra: true }).success
      ).toBe(false);
    });

    it('requires a subject to list versions', () => {
      expect(
        KafkaRegistryListVersionsSchema.safeParse({ connectionId: 'c1', subject: 'orders-value' })
          .success
      ).toBe(true);
      expect(KafkaRegistryListVersionsSchema.safeParse({ connectionId: 'c1' }).success).toBe(false);
    });

    it('requires subject + version (number or latest) to get a schema', () => {
      const ok = (version: unknown) =>
        KafkaRegistryGetSchemaSchema.safeParse({
          connectionId: 'c1',
          subject: 'orders-value',
          version,
        }).success;
      expect(ok('latest')).toBe(true);
      expect(ok(4)).toBe(true);
      expect(ok(-1)).toBe(false);
      expect(ok('4')).toBe(false);
    });
  });
});
