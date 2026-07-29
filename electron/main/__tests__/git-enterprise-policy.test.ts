import { afterEach, describe, expect, it, vi } from 'vitest';
import { managedGitEnvironment } from '../handlers/git-enterprise-policy';
import { prepareManagedGitInvocation } from '../handlers/git-managed-invocation';
import { setManagedEnterprisePolicyForTest } from '../security/managed-enterprise-policy';

const electronSession = { setProxy: vi.fn(), resolveProxy: vi.fn() };

afterEach(() => {
  vi.unstubAllEnvs();
  setManagedEnterprisePolicyForTest({ status: { state: 'unmanaged' } });
});

describe('managed Git network policy', () => {
  it('preserves existing proxy environment behavior when unmanaged', async () => {
    vi.stubEnv('GIT_DIR', '/tmp/redirected-repository');
    vi.stubEnv('HTTPS_PROXY', 'http://existing-proxy.example:3128');

    const env = await managedGitEnvironment(
      'https://git.example/repository.git',
      false,
      electronSession
    );

    expect(env.env.GIT_DIR).toBeUndefined();
    expect(env.env.HTTPS_PROXY).toBe('http://existing-proxy.example:3128');
  });

  it('preserves repository hooks for unmanaged Git operations', async () => {
    setManagedEnterprisePolicyForTest({ status: { state: 'unmanaged' } });

    const invocation = await prepareManagedGitInvocation(undefined, false);

    expect(invocation.configArgs.join(' ')).not.toContain('core.hooksPath');
    await invocation.cleanup();
  });

  it('replaces inherited proxy variables with the fixed managed proxy', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://unmanaged-proxy.example:3128');
    setManagedEnterprisePolicyForTest({
      status: {
        state: 'managed',
        source: 'native',
        networkMode: 'fixed',
        updatesMode: 'disabled',
        requireProxy: true,
      },
      policy: {
        version: 1,
        network: {
          mode: 'fixed',
          requireProxy: true,
          proxyUrl: 'https://managed-proxy.example:8443',
          bypassList: [],
          caCertificatePaths: [],
          requireCertificateVerification: true,
          minimumTlsVersion: 'TLSv1.2',
          directProtocols: [],
        },
        updates: {
          mode: 'disabled',
          channel: 'stable',
          requestHeaderEnv: {},
        },
      },
    });

    const env = await managedGitEnvironment(
      'https://git.example/repository.git',
      false,
      electronSession
    );

    expect(env.env.HTTPS_PROXY).toBeUndefined();
    expect(env.env.HTTP_PROXY).toBeUndefined();
    expect(env.proxyUrl).toBe('https://managed-proxy.example:8443/');
    expect(env.minimumTlsVersion).toBe('TLSv1.2');
  });

  it('selects the first reachable proxy from an ordered PAC chain', async () => {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Could not reserve a dead port');
    const deadPort = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const proxy = await startMockProxyServer({ port: 0 });
    setManagedEnterprisePolicyForTest({
      status: {
        state: 'managed',
        source: 'native',
        networkMode: 'pac',
        updatesMode: 'disabled',
        requireProxy: true,
      },
      policy: {
        version: 1,
        network: {
          mode: 'pac',
          requireProxy: true,
          pacUrl: 'https://config.corp.example/proxy.pac',
          bypassList: [],
          caCertificatePaths: [],
          requireCertificateVerification: true,
          minimumTlsVersion: 'TLSv1.2',
          directProtocols: [],
        },
        updates: {
          mode: 'disabled',
          channel: 'stable',
          requestHeaderEnv: {},
        },
      },
    });
    electronSession.resolveProxy.mockResolvedValueOnce(
      `PROXY 127.0.0.1:${deadPort}; PROXY 127.0.0.1:${proxy.port}`
    );

    try {
      const result = await managedGitEnvironment(
        'https://git.example/repository.git',
        false,
        electronSession
      );
      expect(result.proxyUrl).toBe(`http://127.0.0.1:${proxy.port}/`);
    } finally {
      await proxy.close();
    }
  });

  it('blocks Git SSH unless the direct protocol is explicitly allowed', async () => {
    setManagedEnterprisePolicyForTest({
      status: {
        state: 'managed',
        source: 'native',
        networkMode: 'system',
        updatesMode: 'disabled',
        requireProxy: true,
      },
      policy: {
        version: 1,
        network: {
          mode: 'system',
          requireProxy: true,
          bypassList: [],
          caCertificatePaths: [],
          requireCertificateVerification: true,
          minimumTlsVersion: 'TLSv1.2',
          directProtocols: [],
        },
        updates: {
          mode: 'disabled',
          channel: 'stable',
          requestHeaderEnv: {},
        },
      },
    });

    await expect(
      managedGitEnvironment('ssh://git@git.example/repository.git', true, electronSession)
    ).rejects.toThrow('direct Git SSH connections');
  });

  it('removes policy credential variables from the Git child environment', async () => {
    vi.stubEnv('RESTURA_PROXY_USERNAME', 'managed-user');
    vi.stubEnv('RESTURA_PROXY_PASSWORD', 'managed-password');
    setManagedEnterprisePolicyForTest({
      status: {
        state: 'managed',
        source: 'native',
        networkMode: 'fixed',
        updatesMode: 'disabled',
        requireProxy: true,
      },
      policy: {
        version: 1,
        network: {
          mode: 'fixed',
          requireProxy: true,
          proxyUrl: 'http://proxy.corp.example:8080',
          bypassList: [],
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
          caCertificatePaths: [],
          requireCertificateVerification: true,
          minimumTlsVersion: 'TLSv1.2',
          directProtocols: [],
        },
        updates: {
          mode: 'disabled',
          channel: 'stable',
          requestHeaderEnv: {},
        },
      },
    });

    const result = await managedGitEnvironment(
      'https://git.example/repository.git',
      false,
      electronSession
    );

    expect(result.env.RESTURA_PROXY_USERNAME).toBeUndefined();
    expect(result.env.RESTURA_PROXY_PASSWORD).toBeUndefined();
    expect(result.proxyUrl).toContain('managed-user:managed-password@proxy.corp.example');
    expect(result.proxyAuthMethod).toBe('basic');
  });
});

import { once } from 'node:events';
import { createServer } from 'node:net';
import { startMockProxyServer } from '../../../e2e/mocks/proxyServer';
