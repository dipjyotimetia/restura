import { describe, expect, it, vi } from 'vitest';
import {
  assertManagedDirectProtocolAllowed,
  assertManagedOutboundAllowed,
  getManagedCaCertificateBundle,
  getManagedEnterprisePolicy,
  loadManagedEnterprisePolicy,
  type ManagedPolicyLoadOptions,
  markManagedPolicyRuntimeInvalid,
  setManagedEnterprisePolicyForTest,
} from '../security/managed-enterprise-policy';

const validPolicy = JSON.stringify({
  version: 1,
  network: {
    mode: 'fixed',
    requireProxy: true,
    proxyUrl: 'http://proxy.corp.example:8080',
    bypassList: ['localhost'],
    proxyAuthentication: {
      basic: [
        {
          proxyUrl: 'http://proxy.corp.example:8080',
          usernameEnv: 'RESTURA_PROXY_USERNAME',
          passwordEnv: 'RESTURA_PROXY_PASSWORD',
        },
      ],
      integratedDomains: [],
    },
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

describe('managed enterprise connectivity policy', () => {
  it('keeps desktop behavior unmanaged when no policy source exists', () => {
    const result = loadManagedEnterprisePolicy(options());

    expect(result).toEqual({ status: { state: 'unmanaged' } });
    expect(() => assertManagedOutboundAllowed(result)).not.toThrow();
  });

  it('accepts only the network and updater policy surface', () => {
    const result = loadManagedEnterprisePolicy(options({ readNativePolicy: () => validPolicy }));
    expect(result.status).toEqual({
      state: 'managed',
      source: 'native',
      networkMode: 'fixed',
      updatesMode: 'notify',
      requireProxy: true,
    });

    const broadened = JSON.parse(validPolicy);
    broadened.telemetry = { errorReporting: false };
    expect(
      loadManagedEnterprisePolicy(options({ readNativePolicy: () => JSON.stringify(broadened) }))
        .status
    ).toMatchObject({ state: 'invalid', source: 'native' });
  });

  it('requires absolute managed CA certificate paths', () => {
    const relative = JSON.parse(validPolicy);
    relative.network.caCertificatePaths = ['corporate-ca.pem'];

    expect(
      loadManagedEnterprisePolicy(options({ readNativePolicy: () => JSON.stringify(relative) }))
        .status
    ).toMatchObject({ state: 'invalid', source: 'native' });
  });

  it('accepts origin-bound Basic credentials and integrated-auth domain allowlists', () => {
    const authenticated = JSON.parse(validPolicy);
    authenticated.network.proxyAuthentication = {
      basic: [
        {
          proxyUrl: 'http://proxy.corp.example:8080',
          usernameEnv: 'RESTURA_PROXY_USERNAME',
          passwordEnv: 'RESTURA_PROXY_PASSWORD',
        },
      ],
      integratedDomains: ['proxy.corp.example', '*.regional.corp.example'],
    };

    expect(
      loadManagedEnterprisePolicy(
        options({ readNativePolicy: () => JSON.stringify(authenticated) })
      ).status
    ).toMatchObject({ state: 'managed', source: 'native' });
  });

  it('uses native policy before a selected file and never falls back after invalid input', () => {
    const readFile = vi.fn(() => validPolicy);
    const managed = loadManagedEnterprisePolicy(
      options({
        platform: 'darwin',
        env: { RESTURA_ENTERPRISE_POLICY_FILE: '/tmp/lower-precedence.json' },
        readNativePolicy: () => validPolicy,
        readFile,
      })
    );
    expect(managed.status).toMatchObject({ state: 'managed', source: 'native' });
    expect(readFile).not.toHaveBeenCalled();

    const invalid = loadManagedEnterprisePolicy(
      options({
        readNativePolicy: () => '{"version":1,"unknown":true}',
        readFile,
      })
    );
    expect(invalid.status).toMatchObject({ state: 'invalid', source: 'native' });
    expect(() => assertManagedOutboundAllowed(invalid)).toThrow(
      'Managed enterprise policy is invalid'
    );
  });

  it('requires protected administrator-owned policy files', () => {
    const policyPath = '/etc/restura/policy.json';
    const untrusted = loadManagedEnterprisePolicy(
      options({
        env: { RESTURA_ENTERPRISE_POLICY_FILE: policyPath },
        readFile: () => validPolicy,
        statFile: () => ({ uid: 501, mode: 0o100664, size: validPolicy.length }),
      })
    );
    expect(untrusted.status).toMatchObject({ state: 'invalid' });

    const trusted = loadManagedEnterprisePolicy(
      options({
        env: { RESTURA_ENTERPRISE_POLICY_FILE: policyPath },
        readFile: () => validPolicy,
        statFile: () => ({ uid: 0, mode: 0o100600, size: validPolicy.length }),
      })
    );
    expect(trusted.status).toMatchObject({
      state: 'managed',
      source: 'environment-file',
    });
  });

  it('does not expose selected policy paths in renderer-visible load failures', () => {
    const policyPath = '/etc/restura/private/customer-policy.json';
    const result = loadManagedEnterprisePolicy(
      options({
        env: { RESTURA_ENTERPRISE_POLICY_FILE: policyPath },
        statFile: () => {
          throw new Error(`EACCES: permission denied, stat '${policyPath}'`);
        },
      })
    );

    expect(JSON.stringify(result.status)).not.toContain(policyPath);
    expect(result.status).toMatchObject({
      state: 'invalid',
      message: 'Policy file could not be read or trusted',
    });
  });

  it('requires explicit exceptions for direct raw protocols when proxy egress is mandatory', () => {
    setManagedEnterprisePolicyForTest(
      loadManagedEnterprisePolicy(options({ readNativePolicy: () => validPolicy }))
    );

    expect(() => assertManagedDirectProtocolAllowed('mqtt')).not.toThrow();
    expect(() => assertManagedDirectProtocolAllowed('kafka')).toThrow('direct Kafka connections');
  });

  it('redacts runtime application failures from renderer-visible status', () => {
    setManagedEnterprisePolicyForTest(
      loadManagedEnterprisePolicy(options({ readNativePolicy: () => validPolicy }))
    );
    markManagedPolicyRuntimeInvalid(
      'RESTURA_UPDATE_AUTHORIZATION was missing for https://updates.corp.example'
    );

    const serialized = JSON.stringify(getManagedEnterprisePolicy().status);
    expect(serialized).not.toContain('RESTURA_UPDATE_AUTHORIZATION');
    expect(serialized).not.toContain('updates.corp.example');
    expect(serialized).toContain('Contact your administrator');
  });

  it('rejects managed CA files that are not protected regular files', () => {
    setManagedEnterprisePolicyForTest(
      loadManagedEnterprisePolicy(options({ readNativePolicy: () => validPolicy }))
    );

    expect(() =>
      getManagedCaCertificateBundle({
        platform: 'linux',
        env: {},
        readFile: () => 'not reached',
        statFile: () => ({
          uid: 501,
          mode: 0o100644,
          size: 100,
          isFile: true,
          isSymbolicLink: false,
        }),
      })
    ).toThrow('administrator-owned');

    setManagedEnterprisePolicyForTest(
      loadManagedEnterprisePolicy(options({ readNativePolicy: () => validPolicy }))
    );
    expect(() =>
      getManagedCaCertificateBundle({
        platform: 'linux',
        env: {},
        readFile: () => 'not reached',
        statFile: () => ({
          uid: 0,
          mode: 0o100600,
          size: 100,
          isFile: false,
          isSymbolicLink: true,
        }),
      })
    ).toThrow('regular file');
  });

  it('rejects malformed managed CA certificate material', () => {
    setManagedEnterprisePolicyForTest(
      loadManagedEnterprisePolicy(options({ readNativePolicy: () => validPolicy }))
    );

    expect(() =>
      getManagedCaCertificateBundle({
        platform: 'linux',
        env: {},
        readFile: () => 'not a certificate',
        statFile: () => ({
          uid: 0,
          mode: 0o100600,
          size: 17,
          isFile: true,
          isSymbolicLink: false,
        }),
      })
    ).toThrow('valid X.509');
  });
});
