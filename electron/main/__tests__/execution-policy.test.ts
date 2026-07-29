import { afterEach, describe, expect, it } from 'vitest';
import {
  assertExecutionPolicyReady,
  getExecutionPolicy,
  isExecutionPolicyReady,
  setExecutionPolicy,
} from '../security/execution-policy';
import { setManagedEnterprisePolicyForTest } from '../security/managed-enterprise-policy';

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
  afterEach(() => {
    setManagedEnterprisePolicyForTest({ status: { state: 'unmanaged' } });
  });

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

  it('rejects oversized policy collections at the IPC validation boundary', () => {
    expect(() =>
      setExecutionPolicy({
        ...policy,
        proxy: {
          ...policy.proxy,
          bypassList: Array.from({ length: 101 }, (_, index) => `host-${index}.example.test`),
        },
      })
    ).toThrow('bypassList');
  });

  it('rejects empty certificate material', () => {
    expect(() =>
      setExecutionPolicy({
        ...policy,
        certificates: {
          ...policy.certificates,
          clientCert: { format: 'pfx', pfx: '' },
        },
      })
    ).toThrow('pfx');
  });

  it('blocks outbound execution when the selected managed policy is invalid', () => {
    setExecutionPolicy(policy);
    setManagedEnterprisePolicyForTest({
      status: {
        state: 'invalid',
        source: 'machine-file',
        message: 'Policy does not match the strict EnterprisePolicyV1 schema',
      },
    });

    expect(() => assertExecutionPolicyReady()).toThrow('Managed enterprise policy is invalid');
  });
});
