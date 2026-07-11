import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXECUTION_POLICY,
  ExecutionPolicySchema,
  getExecutionPolicy,
  resolveExecutionPolicyForUrl,
  setExecutionPolicy,
} from '../execution-policy';

const policy = {
  ...DEFAULT_EXECUTION_POLICY,
  allowLocalhost: false,
  allowPrivateIPs: true,
  proxy: {
    enabled: true,
    type: 'https' as const,
    host: 'proxy.example.test',
    port: 8443,
    bypassList: ['*.internal.test'],
    auth: {
      username: 'restura',
      password: { kind: 'handle' as const, id: 'proxy-password' },
    },
  },
  verifySsl: false,
  defaultTimeout: 45_000,
  clientCert: {
    format: 'pem' as const,
    cert: 'global-cert',
    key: 'global-key',
    passphrase: { kind: 'handle' as const, id: 'global-passphrase' },
  },
  caCert: { pem: 'global-ca' },
  clientCertificates: [
    {
      id: 'api-client',
      host: 'api.example.test',
      cert: { format: 'pfx' as const, pfx: 'host-pfx' },
    },
  ],
  caCertificates: [{ id: 'api-ca', host: 'api.example.test', pem: 'host-ca' }],
};

describe('execution policy', () => {
  it('validates a complete policy snapshot and rejects unsupported proxy configuration', () => {
    expect(ExecutionPolicySchema.safeParse(policy).success).toBe(true);
    expect(
      ExecutionPolicySchema.safeParse({
        ...policy,
        proxy: { ...policy.proxy, type: 'pac', pacUrl: 'https://proxy.example.test/pac' },
      }).success
    ).toBe(false);
  });

  it('atomically replaces the main-process snapshot without exposing mutable state', () => {
    setExecutionPolicy(policy);
    const snapshot = getExecutionPolicy();

    expect(snapshot).toEqual(policy);
    snapshot.proxy.bypassList.push('attacker.example.test');

    expect(getExecutionPolicy().proxy.bypassList).toEqual(['*.internal.test']);
  });

  it('prefers host certificate entries over global certificate defaults', () => {
    const resolved = resolveExecutionPolicyForUrl('https://api.example.test', policy);

    expect(resolved.clientCert).toEqual({ format: 'pfx', pfx: 'host-pfx' });
    expect(resolved.caCert).toEqual({ pem: 'host-ca' });
    expect(resolved.clientCert?.passphrase).toBeUndefined();
  });

  it('bypasses the configured proxy for matching hosts', () => {
    expect(
      resolveExecutionPolicyForUrl('https://service.internal.test', policy).proxy
    ).toBeUndefined();
    expect(resolveExecutionPolicyForUrl('https://api.example.test', policy).proxy).toEqual(
      policy.proxy
    );
  });
});
