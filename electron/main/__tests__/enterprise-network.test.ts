import { describe, expect, it, vi } from 'vitest';
import {
  applyManagedTransportPolicy,
  configureManagedDesktopSessions,
  createEnterpriseProxyAgent,
  createEnterpriseProxyAuthorizationLookup,
  createManagedCertificateVerifyProc,
  enterpriseProxyAuthorization,
  enterpriseProxyCandidates,
  managedProxyChallengeResponse,
  resolveManagedProxyForUrl,
} from '../security/enterprise-network';
import type { ManagedPolicyLoadResult } from '../security/managed-enterprise-policy';

const MANAGED_CA = `-----BEGIN CERTIFICATE-----
MIIDNDCCAhygAwIBAgIUUGeWuq5SKopY4kN0KN2xvpWh778wDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQYXBpLmV4YW1wbGUudGVzdDAeFw0yNjA3MjkxMzU0MDBa
Fw0zNjA3MjYxMzU0MDBaMBsxGTAXBgNVBAMMEGFwaS5leGFtcGxlLnRlc3QwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDWVKoLOJZUZKdWfu+YJFtZRuwn
BT1rByhBUB+QIjLoJlNLMlnyvPr+dFA/KlplExPnC2yIlNQ071m6eZ4SJLMRtZ9M
2hxBSUFE5avXXSrMHhJzhSOJiF8kcy+IcX9SmVQkB/O7SeHjGE3xUc0vXBukkzvg
ftvTYPB0WfT+5ZBxAD5bQNye8f+9j8Cxgmze4CiFCXqOlcnJ+zrUg4gBYLttDJBc
2IzvBZPPq1kqWVwOByu9noL1KEPZxOsr1OrbUeqiZ56gTp+3wT97XzWEPyHM/sUQ
n5om0NM91MIIzPY1r+Fgq7d7MGj4G9cEE3LmlToZICZG1xUG27JGgpxf9e6dAgMB
AAGjcDBuMB0GA1UdDgQWBBTHnKTROFr7KL2NSl2F7TRn7EJu0DAfBgNVHSMEGDAW
gBTHnKTROFr7KL2NSl2F7TRn7EJu0DAbBgNVHREEFDASghBhcGkuZXhhbXBsZS50
ZXN0MA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB42zFkVzJzB
6N8j73Wcr/TbX214bx1TwZTvvB93iO8P+/HEeARaQKgU4/pvb9oALsSU1Jp5tnpe
RL0/KSBEwbk2jCrBE82VFei6rXzdv2Z03C1V+uNzNwkDsKvqW2B1FjacraDn8qAi
Jf0VECP2EFH9XToMZOCx4nue62TkfvPeWcoYt3GTl7b72juwD/EP7vKlmbzkEGMs
F9yv73JG6CCN9My9ArskUbskWpKaKD2uSxBNsYNRpmKvWUf0qM+NcuedB5Lr7aX9
wd5yzWaw3QfCb/OcBusoIeWdqz6D1yoEJRYVJNBsQdg/a64tzgf7sSEYLPefOK/x
spxknCrO4Gc=
-----END CERTIFICATE-----`;

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
    const application = {
      setProxy: vi.fn(),
      resolveProxy: vi.fn(),
      setSSLConfig: vi.fn(),
      setCertificateVerifyProc: vi.fn(),
      allowNTLMCredentialsForDomains: vi.fn(),
    };
    const updater = {
      setProxy: vi.fn(),
      resolveProxy: vi.fn(),
      setSSLConfig: vi.fn(),
      setCertificateVerifyProc: vi.fn(),
      allowNTLMCredentialsForDomains: vi.fn(),
    };

    await configureManagedDesktopSessions(
      { application, updater },
      managed({
        proxyAuthentication: {
          basic: [],
          integratedDomains: ['*.corp.example'],
        },
      }),
      MANAGED_CA
    );

    const expected = {
      mode: 'fixed_servers',
      proxyRules: 'http://proxy.corp.example:8080',
    };
    expect(application.setProxy).toHaveBeenCalledWith(expected);
    expect(updater.setProxy).toHaveBeenCalledWith(expected);
    expect(application.setSSLConfig).toHaveBeenCalledWith({ minVersion: 'tls1.2' });
    expect(updater.setSSLConfig).toHaveBeenCalledWith({ minVersion: 'tls1.2' });
    expect(application.allowNTLMCredentialsForDomains).toHaveBeenCalledWith('');
    expect(updater.allowNTLMCredentialsForDomains).toHaveBeenCalledWith('*.corp.example');
    expect(application.setCertificateVerifyProc).toHaveBeenCalledWith(expect.any(Function));
    expect(updater.setCertificateVerifyProc).toHaveBeenCalledWith(expect.any(Function));
    expect(application.setCertificateVerifyProc.mock.invocationCallOrder[0]).toBeLessThan(
      application.setProxy.mock.invocationCallOrder[0]!
    );
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

  it('retains ordered PAC fallbacks and treats SOCKS as SOCKS5', async () => {
    const policy = managed({ mode: 'pac', requireProxy: false });
    const electronSession = {
      setProxy: vi.fn(),
      resolveProxy: vi
        .fn()
        .mockResolvedValue(
          'PROXY primary.corp.example:8080; SOCKS backup.corp.example:1080; DIRECT'
        ),
    };

    await expect(
      resolveManagedProxyForUrl('https://api.example.test', electronSession, policy)
    ).resolves.toMatchObject({
      type: 'http',
      host: 'primary.corp.example',
      resolution: 'PROXY primary.corp.example:8080; SOCKS backup.corp.example:1080; DIRECT',
    });
  });

  it('expands mixed-case DIRECT candidates consistently', () => {
    const policy = managed({ mode: 'pac', requireProxy: false });

    expect(
      enterpriseProxyCandidates(
        {
          enabled: true,
          type: 'http',
          host: 'proxy.corp.example',
          port: 8080,
          resolution: 'PROXY proxy.corp.example:8080; direct',
        },
        policy
      )
    ).toEqual([
      expect.objectContaining({ type: 'http', host: 'proxy.corp.example', port: 8080 }),
      undefined,
    ]);
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

  it('enforces the managed TLS floor on the HTTPS proxy connection', async () => {
    const agent = (await createEnterpriseProxyAgent(
      { type: 'https', host: 'proxy.corp.example', port: 8443 },
      { verifySsl: true, minTlsVersion: 'TLSv1.3' }
    )) as unknown as { connectOpts: { minVersion?: string } };

    expect(agent.connectOpts.minVersion).toBe('TLSv1.3');
  });

  it('builds origin-selected Basic proxy authorization without invoking Kerberos', async () => {
    const initializeClient = vi.fn();

    await expect(
      enterpriseProxyAuthorization(
        {
          type: 'http',
          host: 'proxy.corp.example',
          port: 8080,
          auth: { username: 'managed-user', password: 'managed-password' },
        },
        initializeClient
      )
    ).resolves.toBe(`Basic ${Buffer.from('managed-user:managed-password').toString('base64')}`);
    expect(initializeClient).not.toHaveBeenCalled();
  });

  it('uses the OS credential cache only for an integrated-auth allowlisted proxy', async () => {
    const step = vi.fn().mockResolvedValue('spnego-token');
    const initializeClient = vi.fn().mockResolvedValue({ step });

    await expect(
      enterpriseProxyAuthorization(
        {
          type: 'https',
          host: 'proxy.corp.example',
          port: 8443,
          integratedAuth: true,
        },
        initializeClient
      )
    ).resolves.toBe('Negotiate spnego-token');
    expect(initializeClient).toHaveBeenCalledWith('HTTP@proxy.corp.example');
    expect(step).toHaveBeenCalledWith('');
  });

  it('advances one Kerberos client across repeated proxy challenges', async () => {
    const policy = managed({
      proxyAuthentication: {
        basic: [],
        integratedDomains: ['proxy.corp.example'],
      },
    });
    const step = vi.fn().mockResolvedValueOnce('initial-token').mockResolvedValueOnce('next-token');
    const initializeClient = vi.fn().mockResolvedValue({ step });
    const lookup = createEnterpriseProxyAuthorizationLookup(policy, {}, initializeClient);
    const state = {};

    await expect(lookup('http://proxy.corp.example:8080', undefined, state)).resolves.toBe(
      'Negotiate initial-token'
    );
    await expect(
      lookup('http://proxy.corp.example:8080', 'Negotiate server-token', state)
    ).resolves.toBe('Negotiate next-token');
    expect(initializeClient).toHaveBeenCalledTimes(1);
    expect(step).toHaveBeenNthCalledWith(1, '');
    expect(step).toHaveBeenNthCalledWith(2, 'server-token');
  });

  it('does not access the OS credential cache for an unmarked proxy', async () => {
    const initializeClient = vi.fn();

    await expect(
      enterpriseProxyAuthorization(
        { type: 'http', host: 'public-proxy.example', port: 8080 },
        initializeClient
      )
    ).resolves.toBeUndefined();
    expect(initializeClient).not.toHaveBeenCalled();
  });

  it('trusts a configured CA only for unknown-authority errors and matching hosts', () => {
    const verify = createManagedCertificateVerifyProc(MANAGED_CA);
    const trusted = vi.fn();
    const wrongHost = vi.fn();
    const expiredOrRevoked = vi.fn();
    const certificate = { data: MANAGED_CA };

    verify(
      {
        hostname: 'api.example.test',
        certificate,
        verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID',
        errorCode: -202,
      },
      trusted
    );
    verify(
      {
        hostname: 'other.example.test',
        certificate,
        verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID',
        errorCode: -202,
      },
      wrongHost
    );
    verify(
      {
        hostname: 'api.example.test',
        certificate,
        verificationResult: 'net::ERR_CERT_DATE_INVALID',
        errorCode: -201,
      },
      expiredOrRevoked
    );

    expect(trusted).toHaveBeenCalledWith(0);
    expect(wrongHost).toHaveBeenCalledWith(-202);
    expect(expiredOrRevoked).toHaveBeenCalledWith(-201);
  });

  it('answers Basic proxy challenges and rejects integrated authentication', () => {
    const policy = managed({
      proxyAuthentication: {
        basic: [
          {
            proxyUrl: 'http://proxy.corp.example:8080',
            usernameEnv: 'RESTURA_PROXY_USERNAME',
            passwordEnv: 'RESTURA_PROXY_PASSWORD',
          },
        ],
        integratedDomains: ['*.corp.example'],
      },
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
    ).toEqual({ kind: 'integrated', scheme: 'ntlm' });
  });
});
