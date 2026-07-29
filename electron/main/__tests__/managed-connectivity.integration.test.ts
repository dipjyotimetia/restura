import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyManagedDesktopConnectivity } from '../lifecycle/managed-connectivity';
import { resolveManagedProxyForUrl } from '../security/enterprise-network';
import {
  loadManagedEnterprisePolicy,
  setManagedEnterprisePolicyForTest,
} from '../security/managed-enterprise-policy';

const policyJson = JSON.stringify({
  version: 1,
  network: {
    mode: 'pac',
    requireProxy: true,
    pacUrl: 'https://config.corp.example/restura.pac',
    bypassList: [],
    usernameEnv: undefined,
    passwordEnv: undefined,
    caCertificatePaths: ['/etc/restura/corporate-ca.pem'],
    requireCertificateVerification: true,
    minimumTlsVersion: 'TLSv1.2',
    directProtocols: [],
  },
  updates: {
    mode: 'auto-download',
    channel: 'stable',
    feedUrl: 'https://updates.corp.example/restura',
    requestHeaderEnv: { Authorization: 'RESTURA_UPDATE_AUTHORIZATION' },
  },
});

function updaterStub() {
  return {
    setFeedURL: vi.fn(),
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: true,
    channel: null as string | null,
    requestHeaders: null as Record<string, string> | null,
  };
}

afterEach(() => {
  setManagedEnterprisePolicyForTest({ status: { state: 'unmanaged' } });
});

describe('managed desktop connectivity integration', () => {
  it('applies one protected policy to app traffic, PAC resolution, and the update feed', async () => {
    const policy = loadManagedEnterprisePolicy({
      platform: 'linux',
      env: {},
      readNativePolicy: () => policyJson,
    });
    setManagedEnterprisePolicyForTest(policy);

    const applicationSession = {
      setProxy: vi.fn().mockResolvedValue(undefined),
      resolveProxy: vi.fn().mockResolvedValue('HTTPS proxy.corp.example:8443'),
    };
    const updaterSession = {
      setProxy: vi.fn().mockResolvedValue(undefined),
      resolveProxy: vi.fn().mockResolvedValue('HTTPS proxy.corp.example:8443'),
    };
    const updater = updaterStub();

    await expect(
      applyManagedDesktopConnectivity(
        { applicationSession, updaterSession, updater },
        {
          policy,
          env: { RESTURA_UPDATE_AUTHORIZATION: 'Bearer managed-feed-token' },
          readCaFile: () => 'CORPORATE-CA',
        }
      )
    ).resolves.toEqual({ managed: true, updatesEnabled: true });

    const sessionPolicy = {
      mode: 'pac_script',
      pacScript: 'https://config.corp.example/restura.pac',
    };
    expect(applicationSession.setProxy).toHaveBeenCalledWith(sessionPolicy);
    expect(updaterSession.setProxy).toHaveBeenCalledWith(sessionPolicy);
    await expect(
      resolveManagedProxyForUrl('https://api.example.test', applicationSession, policy)
    ).resolves.toEqual({
      enabled: true,
      type: 'https',
      host: 'proxy.corp.example',
      port: 8443,
    });
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://updates.corp.example/restura',
      channel: 'latest',
    });
    expect(updater.requestHeaders).toEqual({
      Authorization: 'Bearer managed-feed-token',
    });
    expect(updater.autoDownload).toBe(true);
  });
});
