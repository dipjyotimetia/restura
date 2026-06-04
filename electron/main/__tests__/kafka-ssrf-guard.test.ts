// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { assertKafkaBrokersSafe, assertRegistryUrlSafe } from '../kafka-broker-guard';

describe('assertKafkaBrokersSafe', () => {
  it('accepts public broker addresses with default port', () => {
    expect(() =>
      assertKafkaBrokersSafe(['b-1.kafka-cluster.abc.kafka.us-east-1.amazonaws.com:9094'])
    ).not.toThrow();
  });

  it('accepts private-network brokers — Kafka clusters routinely live there', () => {
    expect(() => assertKafkaBrokersSafe(['10.0.5.42:9092'])).not.toThrow();
    expect(() => assertKafkaBrokersSafe(['172.16.0.1:9092'])).not.toThrow();
    expect(() => assertKafkaBrokersSafe(['192.168.1.100:9092'])).not.toThrow();
  });

  it('accepts localhost for local development', () => {
    expect(() => assertKafkaBrokersSafe(['localhost:9092'])).not.toThrow();
    expect(() => assertKafkaBrokersSafe(['127.0.0.1:9092'])).not.toThrow();
  });

  it('rejects cloud metadata literal IP (169.254.169.254)', () => {
    expect(() => assertKafkaBrokersSafe(['169.254.169.254:9092'])).toThrow(
      /Kafka broker .* rejected/
    );
  });

  it('rejects cloud metadata hostname (metadata.google.internal)', () => {
    expect(() => assertKafkaBrokersSafe(['metadata.google.internal:9092'])).toThrow(
      /Kafka broker .* rejected/
    );
  });

  it('rejects kubernetes.default api server hostname', () => {
    expect(() => assertKafkaBrokersSafe(['kubernetes.default:9092'])).toThrow(
      /Kafka broker .* rejected/
    );
  });

  it('rejects empty broker string', () => {
    expect(() => assertKafkaBrokersSafe([''])).toThrow(/Invalid Kafka broker/);
  });

  it('rejects over-long broker strings (DoS prevention)', () => {
    const huge = 'a'.repeat(300) + ':9092';
    expect(() => assertKafkaBrokersSafe([huge])).toThrow(/Invalid Kafka broker/);
  });

  it('rejects the WHOLE connect if any single broker fails', () => {
    // Mixed list — first is fine, second is malicious. Reject all-or-nothing
    // so a malicious importer can't smuggle a metadata broker behind a real one.
    expect(() =>
      assertKafkaBrokersSafe(['b-1.kafka-cluster.amazonaws.com:9094', '169.254.169.254:9092'])
    ).toThrow(/Kafka broker .* rejected/);
  });

  it('accepts IPv6 bracketed broker addresses', () => {
    expect(() => assertKafkaBrokersSafe(['[2001:db8::1]:9092'])).not.toThrow();
  });

  it('rejects broker strings carrying URL userinfo (credentials)', () => {
    // @platformatic/kafka treats the whole string as host:port, so
    // user:pass@... brokers fail downstream with a confusing error. Reject
    // them up front with an actionable message.
    expect(() => assertKafkaBrokersSafe(['admin:secret@broker.example.com:9092'])).toThrow(
      /credentials in broker address/
    );
    expect(() => assertKafkaBrokersSafe(['user@10.0.0.5:9092'])).toThrow(
      /credentials in broker address/
    );
  });
});

describe('assertRegistryUrlSafe', () => {
  it('accepts public and private registry URLs (same posture as brokers)', () => {
    expect(() => assertRegistryUrlSafe('https://schema-registry.example.com')).not.toThrow();
    expect(() => assertRegistryUrlSafe('http://10.0.5.42:8081')).not.toThrow();
    expect(() => assertRegistryUrlSafe('https://192.168.1.100:8081')).not.toThrow();
    expect(() => assertRegistryUrlSafe('http://localhost:8081')).not.toThrow();
  });

  it('rejects cloud metadata endpoints', () => {
    expect(() => assertRegistryUrlSafe('http://169.254.169.254/')).toThrow(
      /Schema Registry URL rejected/
    );
    expect(() => assertRegistryUrlSafe('http://metadata.google.internal/')).toThrow(
      /Schema Registry URL rejected/
    );
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => assertRegistryUrlSafe('ftp://schema-registry:8081')).toThrow(
      /Schema Registry URL rejected/
    );
    expect(() => assertRegistryUrlSafe('file:///etc/passwd')).toThrow(
      /Schema Registry URL rejected/
    );
  });
});
