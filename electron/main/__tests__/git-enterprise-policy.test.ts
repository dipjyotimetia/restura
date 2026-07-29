import { once } from 'node:events';
import { createServer } from 'node:net';
import { rootCertificates } from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  session: { defaultSession: { resolveProxy: vi.fn().mockResolvedValue('DIRECT') } },
}));

import { startMockHttpServer } from '../../../e2e/mocks/httpServer';
import { startMockProxyServer } from '../../../e2e/mocks/proxyServer';
import { combineGitCaBundle, managedGitEnvironment } from '../handlers/git-enterprise-policy';
import {
  normalizeGitConfigPath,
  prepareManagedGitInvocation,
  quoteGitConfigValue,
} from '../handlers/git-managed-invocation';
import { setManagedEnterprisePolicyForTest } from '../security/managed-enterprise-policy';

const electronSession = { setProxy: vi.fn(), resolveProxy: vi.fn() };

function managedDirectPolicy() {
  return {
    status: {
      state: 'managed' as const,
      source: 'native' as const,
      networkMode: 'direct' as const,
      updatesMode: 'disabled' as const,
      requireProxy: false,
    },
    policy: {
      version: 1 as const,
      network: {
        mode: 'direct' as const,
        requireProxy: false,
        bypassList: [],
        caCertificatePaths: [],
        requireCertificateVerification: true as const,
        minimumTlsVersion: 'TLSv1.2' as const,
        directProtocols: [],
      },
      updates: {
        mode: 'disabled' as const,
        channel: 'stable' as const,
        requestHeaderEnv: {},
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  electronSession.setProxy.mockReset();
  electronSession.resolveProxy.mockReset();
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

  it('disables repository hooks for managed Git operations', async () => {
    setManagedEnterprisePolicyForTest(managedDirectPolicy());

    const invocation = await prepareManagedGitInvocation(
      'https://git.example/repository.git',
      false
    );

    expect(invocation.configArgs.join(' ')).toContain('core.hooksPath');
    await invocation.cleanup();
  });

  it('disables repository hooks for managed local Git operations without a remote', async () => {
    setManagedEnterprisePolicyForTest(managedDirectPolicy());

    const invocation = await prepareManagedGitInvocation(undefined, false);

    expect(invocation.configArgs.join(' ')).toContain('core.hooksPath');
    await invocation.cleanup();
  });

  it('retains public roots when adding a managed Git CA bundle', () => {
    const bundle = combineGitCaBundle(
      '-----BEGIN CERTIFICATE-----\nMANAGED\n-----END CERTIFICATE-----'
    );

    expect(bundle).toContain(rootCertificates[0]);
    expect(bundle).toContain('MANAGED');
  });

  it('normalizes Git config paths for Windows config syntax', () => {
    expect(normalizeGitConfigPath('C:\\ProgramData\\Restura\\managed-ca.pem')).toBe(
      'C:/ProgramData/Restura/managed-ca.pem'
    );
  });

  it('quotes Git config paths containing spaces and comment metacharacters', () => {
    expect(quoteGitConfigValue('C:\\Users\\A B\\#managed;ca".pem')).toBe(
      '"C:/Users/A B/#managed;ca\\".pem"'
    );
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
    const [proxy, upstream] = await Promise.all([
      startMockProxyServer({ port: 0 }),
      startMockHttpServer({ port: 0 }),
    ]);
    proxy.setBasicAuth('pac-user', 'pac-password');
    vi.stubEnv('RESTURA_PROXY_USERNAME', 'pac-user');
    vi.stubEnv('RESTURA_PROXY_PASSWORD', 'pac-password');
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
          proxyAuthentication: {
            basic: [
              {
                proxyUrl: `http://127.0.0.1:${proxy.port}`,
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
    electronSession.resolveProxy.mockResolvedValueOnce(
      `PROXY 127.0.0.1:${deadPort}; PROXY 127.0.0.1:${proxy.port}`
    );

    try {
      const result = await managedGitEnvironment(
        `${upstream.url}/repository.git`,
        false,
        electronSession
      );
      expect(result.proxyUrl).toBe(`http://pac-user:pac-password@127.0.0.1:${proxy.port}/`);
      expect(proxy.connectHosts()).toContain(`127.0.0.1:${new URL(upstream.url).port}`);

      const beforeBlockedTarget = proxy.connectCount();
      await expect(
        managedGitEnvironment('https://169.254.169.254/latest/meta-data', false, electronSession)
      ).rejects.toThrow(/blocked|private|metadata|address/i);
      expect(proxy.connectCount()).toBe(beforeBlockedTarget);
    } finally {
      await Promise.all([proxy.close(), upstream.close()]);
    }
  });

  it('falls back to a proxy when an ordered DIRECT Git route is unreachable', async () => {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Could not reserve a dead port');
    let deadTargetPort = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));

    let connectCount = 0;
    const proxySockets = new Set<import('node:net').Socket>();
    const acceptingProxy = createServer((socket) => {
      proxySockets.add(socket);
      socket.once('close', () => proxySockets.delete(socket));
      socket.once('data', () => {
        connectCount += 1;
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      });
    });
    acceptingProxy.listen(0, '127.0.0.1');
    await once(acceptingProxy, 'listening');
    const proxyAddress = acceptingProxy.address();
    if (!proxyAddress || typeof proxyAddress === 'string') {
      throw new Error('Fallback proxy did not bind');
    }
    if (proxyAddress.port === deadTargetPort) {
      const secondReservation = createServer();
      secondReservation.listen(0, '127.0.0.1');
      await once(secondReservation, 'listening');
      const secondAddress = secondReservation.address();
      if (!secondAddress || typeof secondAddress === 'string') {
        throw new Error('Could not reserve a second dead port');
      }
      deadTargetPort = secondAddress.port;
      await new Promise<void>((resolve) => secondReservation.close(() => resolve()));
    }
    setManagedEnterprisePolicyForTest({
      ...managedDirectPolicy(),
      status: {
        state: 'managed',
        source: 'native',
        networkMode: 'pac',
        updatesMode: 'disabled',
        requireProxy: false,
      },
      policy: {
        ...managedDirectPolicy().policy,
        network: {
          ...managedDirectPolicy().policy.network,
          mode: 'pac',
          pacUrl: 'http://config.corp.example/proxy.pac',
        },
      },
    });
    electronSession.resolveProxy.mockResolvedValueOnce(
      `direct; PROXY 127.0.0.1:${proxyAddress.port}`
    );

    try {
      const result = await managedGitEnvironment(
        `http://127.0.0.1:${deadTargetPort}/repository.git`,
        false,
        electronSession
      );
      expect(result.proxyUrl).toBe(`http://127.0.0.1:${proxyAddress.port}/`);
      expect(connectCount).toBe(1);
    } finally {
      for (const socket of proxySockets) socket.destroy();
      await new Promise<void>((resolve) => acceptingProxy.close(() => resolve()));
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
