import { describe, expect, it, vi } from 'vitest';
import {
  assertManagedOutboundAllowed,
  loadManagedEnterprisePolicy,
  type ManagedPolicyLoadOptions,
} from '../security/managed-enterprise-policy';

const validPolicy = JSON.stringify({
  version: 1,
  network: {
    mode: 'fixed',
    requireProxy: true,
    proxyUrl: 'http://proxy.corp.example:8080',
    bypassList: ['localhost'],
    usernameEnv: 'RESTURA_PROXY_USERNAME',
    passwordEnv: 'RESTURA_PROXY_PASSWORD',
    caCertificatePaths: ['/etc/restura/corporate-ca.pem'],
    requireCertificateVerification: true,
    minimumTlsVersion: 'TLSv1.2',
    directProtocols: ['mqtt'],
  },
  updates: {
    mode: 'notify',
    channel: 'stable',
    feedUrl: 'https://updates.corp.example/restura',
    requestHeaderEnv: { Authorization: 'RESTURA_UPDATE_AUTHORIZATION' },
  },
  telemetry: { errorReporting: false, agentTelemetry: false },
  ai: {
    enabled: true,
    providers: ['openai'],
    baseOrigins: ['https://api.openai.com'],
  },
  features: {
    git: true,
    gitSsh: false,
    mcp: true,
    importExport: true,
    mockCapture: false,
    kafka: false,
    mqtt: true,
  },
});

function options(overrides: Partial<ManagedPolicyLoadOptions> = {}): ManagedPolicyLoadOptions {
  const missingFile = () => {
    throw Object.assign(new Error('not found'), { code: 'ENOENT' });
  };
  return {
    platform: 'linux',
    env: {},
    readNativePolicy: () => undefined,
    readFile: missingFile,
    statFile: missingFile,
    ...overrides,
  };
}

describe('managed enterprise policy', () => {
  it('keeps public desktop behavior unmanaged when no policy source exists', () => {
    const result = loadManagedEnterprisePolicy(options());

    expect(result.status).toEqual({ state: 'unmanaged' });
    expect(result.policy).toBeUndefined();
    expect(() => assertManagedOutboundAllowed(result)).not.toThrow();
  });

  it('uses the native machine policy before an environment-selected file', () => {
    const readFile = vi.fn(() => {
      throw new Error('lower-precedence file must not be read');
    });
    const result = loadManagedEnterprisePolicy(
      options({
        platform: 'darwin',
        env: { RESTURA_ENTERPRISE_POLICY_FILE: '/tmp/user-policy.json' },
        readNativePolicy: () => validPolicy,
        readFile,
      })
    );

    expect(result.status).toEqual({
      state: 'managed',
      source: 'native',
      networkMode: 'fixed',
      updatesMode: 'notify',
      requireProxy: true,
    });
    expect(result.policy?.features.gitSsh).toBe(false);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('fails closed on an invalid selected source without falling back', () => {
    const readFile = vi.fn(() => validPolicy);
    const result = loadManagedEnterprisePolicy(
      options({
        platform: 'win32',
        env: { RESTURA_ENTERPRISE_POLICY_FILE: 'C:\\Restura\\policy.json' },
        readNativePolicy: () => '{"version":1,"unknown":true}',
        readFile,
      })
    );

    expect(result.status).toMatchObject({ state: 'invalid', source: 'native' });
    expect(result.policy).toBeUndefined();
    expect(readFile).not.toHaveBeenCalled();
    expect(() => assertManagedOutboundAllowed(result)).toThrow(
      'Managed enterprise policy is invalid'
    );
  });

  it('accepts only administrator-owned policy files on Unix', () => {
    const policyPath = '/etc/restura/policy.json';
    const untrusted = loadManagedEnterprisePolicy(
      options({
        env: { RESTURA_ENTERPRISE_POLICY_FILE: policyPath },
        readFile: () => validPolicy,
        statFile: () => ({ uid: 501, mode: 0o100644, size: validPolicy.length }),
      })
    );

    expect(untrusted.status).toMatchObject({
      state: 'invalid',
      source: 'environment-file',
      message: expect.stringContaining('administrator-owned'),
    });
    expect(() => assertManagedOutboundAllowed(untrusted)).toThrow();

    const trusted = loadManagedEnterprisePolicy(
      options({
        env: { RESTURA_ENTERPRISE_POLICY_FILE: policyPath },
        readFile: () => validPolicy,
        statFile: () => ({ uid: 0, mode: 0o100644, size: validPolicy.length }),
      })
    );
    expect(trusted.status).toMatchObject({
      state: 'managed',
      source: 'environment-file',
    });
  });

  it('rejects group-writable and oversized policy files', () => {
    const policyPath = '/etc/restura/policy.json';
    const groupWritable = loadManagedEnterprisePolicy(
      options({
        env: { RESTURA_ENTERPRISE_POLICY_FILE: policyPath },
        readFile: () => validPolicy,
        statFile: () => ({ uid: 0, mode: 0o100664, size: validPolicy.length }),
      })
    );
    expect(groupWritable.status).toMatchObject({
      state: 'invalid',
      message: expect.stringContaining('must not be group or world writable'),
    });

    const oversized = loadManagedEnterprisePolicy(
      options({
        env: { RESTURA_ENTERPRISE_POLICY_FILE: policyPath },
        readFile: () => validPolicy,
        statFile: () => ({ uid: 0, mode: 0o100600, size: 256 * 1024 + 1 }),
      })
    );
    expect(oversized.status).toMatchObject({
      state: 'invalid',
      message: expect.stringContaining('256 KiB'),
    });
  });

  it('does not expose policy paths, credentials, or update header references in status', () => {
    const result = loadManagedEnterprisePolicy(
      options({
        env: { RESTURA_ENTERPRISE_POLICY_FILE: '/etc/restura/policy.json' },
        readFile: () => validPolicy,
        statFile: () => ({ uid: 0, mode: 0o100600, size: validPolicy.length }),
      })
    );
    const serializedStatus = JSON.stringify(result.status);

    expect(serializedStatus).not.toContain('/etc/restura');
    expect(serializedStatus).not.toContain('RESTURA_PROXY');
    expect(serializedStatus).not.toContain('RESTURA_UPDATE');
    expect(serializedStatus).not.toContain('proxy.corp.example');
  });
});
