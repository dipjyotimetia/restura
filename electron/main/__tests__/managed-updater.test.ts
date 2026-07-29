import { describe, expect, it, vi } from 'vitest';
import { applyManagedUpdaterPolicy } from '../lifecycle/auto-updater';
import type { ManagedPolicyLoadResult } from '../security/managed-enterprise-policy';

function result(
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

describe('managed generic updater', () => {
  it('uses only the administrator generic HTTPS feed and environment-backed headers', () => {
    const target = updater();

    expect(
      applyManagedUpdaterPolicy(target, result(), {
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

  it('maps auto-download and install-on-quit without adding rollout logic', () => {
    const autoDownload = updater();
    applyManagedUpdaterPolicy(
      autoDownload,
      result({ mode: 'auto-download', requestHeaderEnv: {} })
    );
    expect(autoDownload.autoDownload).toBe(true);
    expect(autoDownload.autoInstallOnAppQuit).toBe(false);

    const installOnQuit = updater();
    applyManagedUpdaterPolicy(
      installOnQuit,
      result({ mode: 'install-on-quit', channel: 'beta', requestHeaderEnv: {} })
    );
    expect(installOnQuit.autoDownload).toBe(true);
    expect(installOnQuit.autoInstallOnAppQuit).toBe(true);
    expect(installOnQuit.allowPrerelease).toBe(true);
    expect(installOnQuit.channel).toBe('beta');
  });

  it('disables every updater side effect when managed updates are disabled', () => {
    const target = updater();

    expect(
      applyManagedUpdaterPolicy(target, result({ mode: 'disabled', requestHeaderEnv: {} }))
    ).toEqual({ managed: true, enabled: false });
    expect(target.setFeedURL).not.toHaveBeenCalled();
    expect(target.autoDownload).toBe(false);
    expect(target.autoInstallOnAppQuit).toBe(false);
  });

  it('fails closed when a configured update header environment value is missing', () => {
    expect(() => applyManagedUpdaterPolicy(updater(), result(), {})).toThrow(
      'update header environment variable'
    );
  });

  it('leaves the public GitHub updater unchanged when no managed policy exists', () => {
    const target = updater();

    expect(applyManagedUpdaterPolicy(target, { status: { state: 'unmanaged' } })).toEqual({
      managed: false,
      enabled: true,
    });
    expect(target.setFeedURL).not.toHaveBeenCalled();
  });
});
