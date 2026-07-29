import { afterEach, describe, expect, it, vi } from 'vitest';
import { managedGitEnvironment } from '../handlers/git-enterprise-policy';
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

    expect(env.GIT_DIR).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe('http://existing-proxy.example:3128');
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

    expect(env.HTTPS_PROXY).toBe('https://managed-proxy.example:8443/');
    expect(env.HTTP_PROXY).toBe('https://managed-proxy.example:8443/');
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
});
