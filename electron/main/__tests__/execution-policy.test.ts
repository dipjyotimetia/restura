import { describe, expect, it } from 'vitest';
import {
  assertExecutionPolicyReady,
  getExecutionPolicy,
  isExecutionPolicyReady,
  setExecutionPolicy,
} from '../security/execution-policy';

const handle = { kind: 'handle' as const, id: 'secret-id', label: 'Production secret' };

const policy = {
  security: { allowLocalhost: false, allowPrivateIPs: true },
  proxy: {
    enabled: true,
    type: 'https' as const,
    host: 'proxy.example.test',
    port: 8443,
    bypassList: ['localhost'],
    auth: { username: 'proxy-user', password: handle },
  },
  timeout: 45_000,
  tls: {
    verifySsl: false,
    serverCipherOrder: true,
    minTlsVersion: 'TLSv1.2' as const,
    cipherSuites: 'HIGH:!aNULL',
  },
  certificates: {
    clientCert: { format: 'pfx' as const, pfx: 'cGZ4', passphrase: handle },
    caCert: { pem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----' },
    clientCertificates: [
      {
        id: 'client-1',
        host: '*.example.test',
        port: 443,
        cert: { format: 'pem' as const, cert: 'CERT', key: 'KEY', passphrase: handle },
      },
    ],
    caCertificates: [
      {
        id: 'ca-1',
        host: 'api.example.test',
        pem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
      },
    ],
  },
};

describe('execution policy', () => {
  it('is not ready until the renderer acknowledgement is accepted', () => {
    expect(isExecutionPolicyReady()).toBe(false);
    expect(() => assertExecutionPolicyReady()).toThrow(
      'Execution policy has not been acknowledged'
    );
  });

  it('stores a validated full snapshot while preserving opaque SecretRefs', () => {
    setExecutionPolicy(policy);

    expect(isExecutionPolicyReady()).toBe(true);
    expect(getExecutionPolicy()).toEqual(policy);
    expect(getExecutionPolicy().proxy.auth?.password).toEqual(handle);
    expect(getExecutionPolicy().certificates.clientCert?.passphrase).toEqual(handle);
    expect(() => assertExecutionPolicyReady()).not.toThrow();
  });

  it('does not expose a mutable reference to its stored snapshot', () => {
    setExecutionPolicy(policy);
    const snapshot = getExecutionPolicy();
    snapshot.security.allowLocalhost = true;

    expect(getExecutionPolicy().security.allowLocalhost).toBe(false);
  });

  it('rejects malformed policy snapshots before acknowledging them', () => {
    expect(() => setExecutionPolicy({ ...policy, timeout: 0 })).toThrow('timeout');
  });
});
