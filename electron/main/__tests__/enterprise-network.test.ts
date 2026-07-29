import { describe, expect, it, vi } from 'vitest';
import {
  applyManagedSessionProxy,
  applyManagedTransportPolicy,
  managedProxyChallengeResponse,
  resolveManagedProxyForUrl,
} from '../security/enterprise-network';
import type { ManagedPolicyLoadResult } from '../security/managed-enterprise-policy';

function managed(
  network: Partial<NonNullable<ManagedPolicyLoadResult['policy']>['network']> = {}
): ManagedPolicyLoadResult {
  return {
    status: {
      state: 'managed',
      source: 'native',
      networkMode: network.mode ?? 'fixed',
      updatesMode: 'disabled',
      requireProxy: network.requireProxy ?? true,
    },
    policy: {
      version: 1,
      network: {
        mode: 'fixed',
        requireProxy: true,
        proxyUrl: 'http://proxy.corp.example:8080',
        bypassList: [],
        caCertificatePaths: [],
        requireCertificateVerification: true,
        minimumTlsVersion: 'TLSv1.2',
        directProtocols: [],
        ...network,
      },
      updates: {
        mode: 'disabled',
        channel: 'stable',
        requestHeaderEnv: {},
      },
      telemetry: { errorReporting: false, agentTelemetry: false },
      ai: { enabled: false, providers: [], baseOrigins: [] },
      features: {
        git: false,
        gitSsh: false,
        mcp: false,
        importExport: false,
        mockCapture: false,
        kafka: false,
        mqtt: false,
      },
    },
  };
}

describe('enterprise network service', () => {
  it.each([
    ['system', { mode: 'system' }],
    [
      'fixed',
      {
        mode: 'fixed_servers',
        proxyRules: 'http://proxy.corp.example:8080',
        proxyBypassRules: 'localhost,*.corp.example',
      },
    ],
    [
      'pac',
      {
        mode: 'pac_script',
        pacScript: 'https://config.corp.example/proxy.pac',
        mandatory: true,
      },
    ],
    ['direct', { mode: 'direct' }],
  ] as const)('configures the Electron session for %s mode', async (mode, expected) => {
    const setProxy = vi.fn().mockResolvedValue(undefined);
    const result = managed({
      mode,
      requireProxy: mode !== 'direct',
      ...(mode === 'pac' ? { pacUrl: 'https://config.corp.example/proxy.pac' } : {}),
      bypassList: ['localhost', '*.corp.example'],
    });

    await applyManagedSessionProxy({ setProxy, resolveProxy: vi.fn() }, result);

    expect(setProxy).toHaveBeenCalledWith(expected);
  });

  it('resolves fixed proxy credentials only from named environment variables', async () => {
    const result = managed({
      usernameEnv: 'RESTURA_PROXY_USERNAME',
      passwordEnv: 'RESTURA_PROXY_PASSWORD',
    });

    await expect(
      resolveManagedProxyForUrl(
        'https://api.example.test',
        { setProxy: vi.fn(), resolveProxy: vi.fn() },
        result,
        {
          RESTURA_PROXY_USERNAME: 'proxy-user',
          RESTURA_PROXY_PASSWORD: 'proxy-password',
        }
      )
    ).resolves.toEqual({
      enabled: true,
      type: 'http',
      host: 'proxy.corp.example',
      port: 8080,
      auth: { username: 'proxy-user', password: 'proxy-password' },
    });
  });

  it('fails closed when PAC or system resolution returns DIRECT', async () => {
    const result = managed({
      mode: 'pac',
      pacUrl: 'https://config.corp.example/proxy.pac',
    });

    await expect(
      resolveManagedProxyForUrl(
        'https://api.example.test',
        { setProxy: vi.fn(), resolveProxy: vi.fn().mockResolvedValue('DIRECT') },
        result
      )
    ).rejects.toThrow('requires a proxy');
  });

  it('allows an administrator-defined bypass to resolve directly', async () => {
    const result = managed({
      mode: 'pac',
      pacUrl: 'https://config.corp.example/proxy.pac',
      bypassList: ['*.corp.example'],
    });

    await expect(
      resolveManagedProxyForUrl(
        'https://service.corp.example',
        { setProxy: vi.fn(), resolveProxy: vi.fn().mockResolvedValue('DIRECT') },
        result
      )
    ).resolves.toBeUndefined();
  });

  it('rejects unsupported proxy directives instead of bypassing them', async () => {
    const result = managed({ mode: 'system' });

    await expect(
      resolveManagedProxyForUrl(
        'https://api.example.test',
        { setProxy: vi.fn(), resolveProxy: vi.fn().mockResolvedValue('QUIC proxy.example:443') },
        result
      )
    ).rejects.toThrow('Unsupported enterprise proxy directive');
  });

  it('forces certificate verification, minimum TLS, and the managed CA bundle', () => {
    const result = managed({ minimumTlsVersion: 'TLSv1.3' });

    expect(
      applyManagedTransportPolicy(
        {
          verifySsl: false,
          minTlsVersion: 'TLSv1',
          caCert: { pem: 'REQUEST-CA' },
        },
        result,
        'MANAGED-CA'
      )
    ).toEqual({
      verifySsl: true,
      minTlsVersion: 'TLSv1.3',
      caCert: { pem: 'MANAGED-CA\nREQUEST-CA' },
    });
  });

  it('answers Basic proxy challenges but rejects integrated authentication', () => {
    const result = managed({
      usernameEnv: 'RESTURA_PROXY_USERNAME',
      passwordEnv: 'RESTURA_PROXY_PASSWORD',
    });
    const env = {
      RESTURA_PROXY_USERNAME: 'proxy-user',
      RESTURA_PROXY_PASSWORD: 'proxy-password',
    };

    expect(
      managedProxyChallengeResponse(
        { isProxy: true, scheme: 'basic', host: 'proxy.corp.example', port: 8080 },
        result,
        env
      )
    ).toEqual({
      kind: 'credentials',
      username: 'proxy-user',
      password: 'proxy-password',
    });
    expect(
      managedProxyChallengeResponse(
        { isProxy: true, scheme: 'ntlm', host: 'proxy.corp.example', port: 8080 },
        result,
        env
      )
    ).toEqual({ kind: 'unsupported', scheme: 'ntlm' });
  });
});
