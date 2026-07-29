import { describe, expect, it, vi } from 'vitest';
import {
  applyManagedTransportPolicy,
  configureManagedDesktopSessions,
  managedProxyChallengeResponse,
  resolveManagedProxyForUrl,
} from '../security/enterprise-network';
import type { ManagedPolicyLoadResult } from '../security/managed-enterprise-policy';

function managed(
  network: Partial<NonNullable<ManagedPolicyLoadResult['policy']>['network']> = {}
): ManagedPolicyLoadResult {
  const mode = network.mode ?? 'fixed';
  return {
    status: {
      state: 'managed',
      source: 'native',
      networkMode: mode,
      updatesMode: 'notify',
      requireProxy: network.requireProxy ?? true,
    },
    policy: {
      version: 1,
      network: {
        mode,
        requireProxy: true,
        ...(mode === 'fixed' ? { proxyUrl: 'http://proxy.corp.example:8080' } : {}),
        ...(mode === 'pac' ? { pacUrl: 'https://config.corp.example/proxy.pac' } : {}),
        bypassList: [],
        caCertificatePaths: [],
        requireCertificateVerification: true,
        minimumTlsVersion: 'TLSv1.2',
        directProtocols: [],
        ...network,
      },
      updates: {
        mode: 'notify',
        channel: 'stable',
        feedUrl: 'https://updates.corp.example/restura',
        requestHeaderEnv: {},
      },
    },
  };
}

describe('enterprise network service', () => {
  it('configures both application and updater sessions before outbound work', async () => {
    const application = { setProxy: vi.fn(), resolveProxy: vi.fn(), setSSLConfig: vi.fn() };
    const updater = { setProxy: vi.fn(), resolveProxy: vi.fn(), setSSLConfig: vi.fn() };

    await configureManagedDesktopSessions({ application, updater }, managed());

    const expected = {
      mode: 'fixed_servers',
      proxyRules: 'http://proxy.corp.example:8080',
    };
    expect(application.setProxy).toHaveBeenCalledWith(expected);
    expect(updater.setProxy).toHaveBeenCalledWith(expected);
    expect(application.setSSLConfig).toHaveBeenCalledWith({ minVersion: 'tls1.2' });
    expect(updater.setSSLConfig).toHaveBeenCalledWith({ minVersion: 'tls1.2' });
  });

  it('uses PAC in mandatory mode and fails closed on a direct result', async () => {
    const policy = managed({ mode: 'pac', requireProxy: true });
    const session = {
      setProxy: vi.fn(),
      resolveProxy: vi.fn().mockResolvedValue('DIRECT'),
    };

    await configureManagedDesktopSessions({ application: session, updater: session }, policy);
    expect(session.setProxy).toHaveBeenCalledWith({
      mode: 'pac_script',
      pacScript: 'https://config.corp.example/proxy.pac',
    });
    await expect(
      resolveManagedProxyForUrl('https://api.example.test', session, policy)
    ).rejects.toThrow('requires a proxy');
  });

  it('resolves fixed Basic credentials only from named environment variables', async () => {
    const policy = managed({
      usernameEnv: 'RESTURA_PROXY_USERNAME',
      passwordEnv: 'RESTURA_PROXY_PASSWORD',
    });

    await expect(
      resolveManagedProxyForUrl(
        'https://api.example.test',
        { setProxy: vi.fn(), resolveProxy: vi.fn() },
        policy,
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

  it('parses IPv6 PAC proxy results without producing an invalid proxy URL', async () => {
    const policy = managed({ mode: 'system' });
    const electronSession = {
      setProxy: vi.fn(),
      resolveProxy: vi.fn().mockResolvedValue('HTTPS [2001:db8::10]:8443'),
    };

    await expect(
      resolveManagedProxyForUrl('https://api.example.test', electronSession, policy)
    ).resolves.toMatchObject({
      type: 'https',
      host: '2001:db8::10',
      port: 8443,
    });
  });

  it('forces certificate verification, minimum TLS, and managed CA trust', () => {
    const resolved = applyManagedTransportPolicy(
      {
        verifySsl: false,
        minTlsVersion: 'TLSv1',
        caCert: { pem: 'REQUEST-CA' },
      },
      managed({ minimumTlsVersion: 'TLSv1.3' }),
      'MANAGED-CA'
    );

    expect(resolved.verifySsl).toBe(true);
    expect(resolved.minTlsVersion).toBe('TLSv1.3');
    expect(resolved.caCert?.pem).toContain('MANAGED-CA');
    expect(resolved.caCert?.pem).toMatch(/MANAGED-CA\nREQUEST-CA$/);
  });

  it('answers Basic proxy challenges and rejects integrated authentication', () => {
    const policy = managed({
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
        policy,
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
        policy,
        env
      )
    ).toEqual({ kind: 'unsupported', scheme: 'ntlm' });
  });
});
