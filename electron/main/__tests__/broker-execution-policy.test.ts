import { beforeEach, describe, expect, it } from 'vitest';
import {
  resolveKafkaExecutionPolicy,
  resolveMqttExecutionPolicy,
  resolveSchemaRegistryExecutionPolicy,
} from '../security/broker-execution-policy';
import { setExecutionPolicy } from '../security/execution-policy';

const globalClientCert = { format: 'pem' as const, cert: 'GLOBAL-CERT', key: 'GLOBAL-KEY' };
const hostClientCert = { format: 'pfx' as const, pfx: 'aG9zdC1wZng=' };

beforeEach(() => {
  setExecutionPolicy({
    security: { allowLocalhost: true, allowPrivateIPs: false },
    proxy: {
      enabled: true,
      type: 'socks5',
      host: 'proxy.example.test',
      port: 1080,
      bypassList: [],
    },
    timeout: 45_000,
    tls: {
      verifySsl: false,
      serverCipherOrder: true,
      minTlsVersion: 'TLSv1.2',
      cipherSuites: 'HIGH:!aNULL',
    },
    certificates: {
      clientCert: globalClientCert,
      caCert: { pem: 'GLOBAL-CA' },
      clientCertificates: [{ id: 'host-client', host: '*.example.test', cert: hostClientCert }],
      caCertificates: [{ id: 'host-ca', host: 'mqtt.example.test', pem: 'HOST-CA' }],
    },
  });
});

describe('broker execution policy', () => {
  it('applies global MQTT timeout, SOCKS proxy, and host-selected TLS material', () => {
    expect(
      resolveMqttExecutionPolicy({ brokerUrl: 'mqtts://mqtt.example.test:8883' })
    ).toMatchObject({
      connectTimeout: 45_000,
      socksProxy: 'socks5h://proxy.example.test:1080',
      tls: {
        rejectUnauthorized: false,
        pfx: expect.any(Buffer),
        ca: 'HOST-CA',
        minVersion: 'TLSv1.2',
        ciphers: 'HIGH:!aNULL',
        honorCipherOrder: true,
      },
    });
  });

  it('keeps explicit MQTT connect and TLS values over global defaults', () => {
    expect(
      resolveMqttExecutionPolicy({
        brokerUrl: 'mqtts://mqtt.example.test:8883',
        connectTimeout: 1_000,
        tls: { ca: 'REQUEST-CA', rejectUnauthorized: true },
      })
    ).toMatchObject({
      connectTimeout: 1_000,
      tls: expect.objectContaining({ ca: 'REQUEST-CA', rejectUnauthorized: true }),
    });
  });

  it('applies global Kafka timeout and TLS defaults to SSL connections', () => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 45_000,
      tls: {
        verifySsl: false,
        serverCipherOrder: true,
        minTlsVersion: 'TLSv1.2',
        cipherSuites: 'HIGH:!aNULL',
      },
      certificates: {
        clientCert: globalClientCert,
        caCert: { pem: 'GLOBAL-CA' },
        clientCertificates: [],
        caCertificates: [],
      },
    });
    expect(
      resolveKafkaExecutionPolicy({
        bootstrapBrokers: ['kafka.example.test:9093'],
        usesTls: true,
      })
    ).toMatchObject({
      connectTimeout: 45_000,
      tls: {
        rejectUnauthorized: false,
        cert: 'GLOBAL-CERT',
        key: 'GLOBAL-KEY',
        ca: 'GLOBAL-CA',
        minVersion: 'TLSv1.2',
        ciphers: 'HIGH:!aNULL',
        honorCipherOrder: true,
      },
    });
  });

  it('fails closed when Kafka is configured to use an unsupported proxy', () => {
    expect(() =>
      resolveKafkaExecutionPolicy({
        bootstrapBrokers: ['kafka.example.test:9093'],
        usesTls: true,
      })
    ).toThrow(/Kafka client cannot honor the configured SOCKS5 proxy/);
  });

  describe('every bootstrap broker is checked (SEC-K2)', () => {
    const noProxy = { enabled: false, type: 'http' as const, host: '', port: 8080, bypassList: [] };
    const tls = { verifySsl: true, serverCipherOrder: false };

    it('fails closed when the proxy applies only to the second broker', () => {
      setExecutionPolicy({
        security: { allowLocalhost: true, allowPrivateIPs: false },
        proxy: {
          enabled: true,
          type: 'socks5',
          host: 'proxy.example.test',
          port: 1080,
          bypassList: ['kafka-1.internal.test'],
        },
        timeout: 30_000,
        tls,
        certificates: { clientCertificates: [], caCertificates: [] },
      });
      // The first broker alone is bypassed, so it connects…
      expect(() =>
        resolveKafkaExecutionPolicy({
          bootstrapBrokers: ['kafka-1.internal.test:9092'],
          usesTls: false,
        })
      ).not.toThrow();
      // …but a proxied second broker must not be dialled directly.
      expect(() =>
        resolveKafkaExecutionPolicy({
          bootstrapBrokers: ['kafka-1.internal.test:9092', 'kafka-2.example.test:9092'],
          usesTls: false,
        })
      ).toThrow(/proxy for broker kafka-2\.example\.test:9092/);
    });

    it('rejects a per-host client certificate that matches only one TLS broker', () => {
      setExecutionPolicy({
        security: { allowLocalhost: true, allowPrivateIPs: false },
        proxy: noProxy,
        timeout: 30_000,
        tls,
        certificates: {
          clientCertificates: [
            { id: 'b1-only', host: 'kafka-1.example.test', cert: hostClientCert },
          ],
          caCertificates: [],
        },
      });
      expect(() =>
        resolveKafkaExecutionPolicy({
          bootstrapBrokers: ['kafka-1.example.test:9093', 'kafka-2.example.test:9093'],
          usesTls: true,
        })
      ).toThrow(/different TLS certificates/);
      // Without TLS the per-host certificate is irrelevant.
      expect(() =>
        resolveKafkaExecutionPolicy({
          bootstrapBrokers: ['kafka-1.example.test:9092', 'kafka-2.example.test:9092'],
          usesTls: false,
        })
      ).not.toThrow();
    });

    it('accepts brokers that resolve to identical TLS material', () => {
      setExecutionPolicy({
        security: { allowLocalhost: true, allowPrivateIPs: false },
        proxy: noProxy,
        timeout: 30_000,
        tls,
        certificates: {
          clientCert: globalClientCert,
          clientCertificates: [{ id: 'all', host: '*.example.test', cert: hostClientCert }],
          caCertificates: [],
        },
      });
      const resolved = resolveKafkaExecutionPolicy({
        bootstrapBrokers: ['kafka-1.example.test:9093', 'kafka-2.example.test:9093'],
        usesTls: true,
      });
      expect(resolved.tls).toMatchObject({ pfx: expect.any(Buffer), rejectUnauthorized: true });
    });
  });

  describe('schema registry', () => {
    const noProxy = { enabled: false, type: 'http' as const, host: '', port: 8080, bypassList: [] };

    it('applies host-selected CA, mTLS and the verify toggle to HTTPS registries', () => {
      setExecutionPolicy({
        security: { allowLocalhost: true, allowPrivateIPs: false },
        proxy: noProxy,
        timeout: 12_000,
        tls: { verifySsl: false, serverCipherOrder: false, minTlsVersion: 'TLSv1.2' },
        certificates: {
          clientCert: globalClientCert,
          caCert: { pem: 'GLOBAL-CA' },
          clientCertificates: [
            { id: 'reg-client', host: 'registry.example.test', cert: hostClientCert },
          ],
          caCertificates: [{ id: 'reg-ca', host: 'registry.example.test', pem: 'REGISTRY-CA' }],
        },
      });
      const resolved = resolveSchemaRegistryExecutionPolicy('https://registry.example.test:8081');
      expect(resolved.timeout).toBe(12_000);
      expect(resolved.tls).toMatchObject({
        ca: 'REGISTRY-CA',
        pfx: expect.any(Buffer),
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2',
      });
    });

    it('falls back to global TLS material and verifies by default', () => {
      setExecutionPolicy({
        security: { allowLocalhost: true, allowPrivateIPs: false },
        proxy: noProxy,
        timeout: 30_000,
        tls: { verifySsl: true, serverCipherOrder: false },
        certificates: {
          clientCert: globalClientCert,
          caCert: { pem: 'GLOBAL-CA' },
          clientCertificates: [],
          caCertificates: [],
        },
      });
      expect(resolveSchemaRegistryExecutionPolicy('https://other.example.test').tls).toEqual({
        cert: 'GLOBAL-CERT',
        key: 'GLOBAL-KEY',
        ca: 'GLOBAL-CA',
        rejectUnauthorized: true,
      });
    });

    it('omits TLS material for plain HTTP registries', () => {
      setExecutionPolicy({
        security: { allowLocalhost: true, allowPrivateIPs: false },
        proxy: noProxy,
        timeout: 30_000,
        tls: { verifySsl: true, serverCipherOrder: false },
        certificates: { clientCertificates: [], caCertificates: [] },
      });
      expect(resolveSchemaRegistryExecutionPolicy('http://localhost:8081')).toEqual({
        timeout: 30_000,
      });
    });

    it('fails closed when a proxy applies to the registry host', () => {
      expect(() => resolveSchemaRegistryExecutionPolicy('https://registry.example.test')).toThrow(
        /Schema Registry client cannot honor the configured SOCKS5 proxy/
      );
    });
  });
});
