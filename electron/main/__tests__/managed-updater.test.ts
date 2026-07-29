import { describe, expect, it, vi } from 'vitest';
import {
  applyManagedUpdaterPolicy,
  assertManagedUpdaterProxyRoute,
  checkForUpdatesWithPolicy,
} from '../lifecycle/auto-updater';
import type { ManagedPolicyLoadResult } from '../security/managed-enterprise-policy';

function managedUpdates(
  updates: Partial<NonNullable<ManagedPolicyLoadResult['policy']>['updates']> = {}
): ManagedPolicyLoadResult {
  return {
    status: {
      state: 'managed',
      source: 'native',
      networkMode: 'system',
      updatesMode: updates.mode ?? 'notify',
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
        mode: 'notify',
        channel: 'stable',
        feedUrl: 'https://updates.corp.example/restura',
        requestHeaderEnv: { Authorization: 'RESTURA_UPDATE_AUTHORIZATION' },
        ...updates,
      },
    },
  };
}

function updater() {
  return {
    setFeedURL: vi.fn(),
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    allowDowngrade: true,
    channel: null as string | null,
    requestHeaders: null as Record<string, string> | null,
  };
}

describe('managed updater feed', () => {
  it('uses the administrator HTTPS feed and environment-backed headers', () => {
    const target = updater();

    expect(
      applyManagedUpdaterPolicy(target, managedUpdates(), {
        RESTURA_UPDATE_AUTHORIZATION: 'Bearer update-token',
      })
    ).toEqual({ managed: true, enabled: true });
    expect(target.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://updates.corp.example/restura',
      channel: 'latest',
    });
    expect(target.requestHeaders).toEqual({ Authorization: 'Bearer update-token' });
    expect(target.autoDownload).toBe(false);
    expect(target.autoInstallOnAppQuit).toBe(false);
    expect(target.allowDowngrade).toBe(false);
  });

  it('never falls back to the public feed when managed setup is invalid', () => {
    const target = updater();

    expect(() => applyManagedUpdaterPolicy(target, managedUpdates(), {})).toThrow(
      'update header environment variable'
    );
    expect(target.setFeedURL).not.toHaveBeenCalled();
  });

  it('leaves the existing public updater unchanged when unmanaged', () => {
    const target = updater();

    expect(applyManagedUpdaterPolicy(target, { status: { state: 'unmanaged' } })).toEqual({
      managed: false,
      enabled: true,
    });
    expect(target.setFeedURL).not.toHaveBeenCalled();
  });

  it('fails closed when a mandatory system or PAC route resolves direct', async () => {
    const policy = managedUpdates();
    policy.policy!.network.mode = 'pac';
    policy.policy!.network.pacUrl = 'https://config.corp.example/restura.pac';
    delete policy.policy!.network.proxyUrl;

    await expect(
      assertManagedUpdaterProxyRoute(policy, {
        setProxy: vi.fn(),
        resolveProxy: vi.fn().mockResolvedValue('DIRECT'),
      })
    ).rejects.toThrow('requires a proxy');
  });

  it('does not contact any update feed when managed updates are disabled', async () => {
    const check = vi.fn();

    await expect(
      checkForUpdatesWithPolicy({
        isDev: false,
        managed: managedUpdates({ mode: 'disabled', feedUrl: undefined }),
        currentVersion: '1.9.0',
        check,
      })
    ).resolves.toEqual({
      updateAvailable: false,
      message: 'Updates are disabled by managed policy',
    });
    expect(check).not.toHaveBeenCalled();
  });

  it('does not contact the public feed when managed policy is invalid', async () => {
    const check = vi.fn();

    await expect(
      checkForUpdatesWithPolicy({
        isDev: false,
        managed: {
          status: {
            state: 'invalid',
            source: 'machine-file',
            message: 'Managed enterprise policy could not be applied.',
          },
        },
        currentVersion: '1.9.0',
        check,
      })
    ).resolves.toEqual({
      updateAvailable: false,
      message: 'Updates are blocked because managed policy is invalid',
    });
    expect(check).not.toHaveBeenCalled();
  });
});
