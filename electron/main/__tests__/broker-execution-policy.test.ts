import { beforeEach, describe, expect, it } from 'vitest';
import {
  resolveKafkaExecutionPolicy,
  resolveMqttExecutionPolicy,
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
});
