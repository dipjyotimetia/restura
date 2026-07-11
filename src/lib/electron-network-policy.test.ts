import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirrors electron-sentry.test.ts: fresh module per test (the module-level
// `subscribed` flag must not bleed), deps mocked, subscriber captured.

beforeEach(() => {
  vi.resetModules();
});

interface Settings {
  allowLocalhost?: boolean;
  allowPrivateIPs?: boolean;
  proxy?: {
    enabled: boolean;
    type: 'http' | 'https' | 'socks4' | 'socks5' | 'none';
    host: string;
    port: number;
    bypassList?: string[];
  };
  defaultTimeout?: number;
  verifySsl?: boolean;
  clientCert?: { format: 'pfx' | 'pem'; pfx?: string; cert?: string; key?: string };
  caCert?: { pem: string };
  clientCertificates?: Array<{
    id: string;
    host: string;
    cert: { format: 'pfx' | 'pem'; pfx?: string; cert?: string; key?: string };
  }>;
  caCertificates?: Array<{ id: string; host: string; pem: string }>;
  serverCipherOrder?: boolean;
  minTlsVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
  cipherSuites?: string;
}

async function load(
  isElectronValue: boolean,
  settings: Settings,
  hydrated = true,
  setExecutionPolicyMock = vi.fn().mockResolvedValue({ ok: true })
) {
  let subscriber: ((s: { settings: Settings }) => void) | null = null;
  let finishHydration: (() => void) | null = null;

  vi.doMock('@/lib/shared/platform', () => ({ isElectron: () => isElectronValue }));

  vi.doMock('@/store/useSettingsStore', () => ({
    useSettingsStore: {
      getState: () => ({ settings }),
      subscribe: (cb: typeof subscriber) => {
        subscriber = cb;
        return () => {};
      },
      persist: {
        hasHydrated: () => hydrated,
        onFinishHydration: (cb: () => void) => {
          finishHydration = cb;
          return () => {};
        },
      },
    },
  }));

  Object.defineProperty(globalThis, 'window', {
    value: { electron: { security: { setExecutionPolicy: setExecutionPolicyMock } } },
    writable: true,
    configurable: true,
  });

  const { initNetworkPolicySync } = await import('./electron-network-policy');
  return {
    initNetworkPolicySync,
    setExecutionPolicyMock,
    get triggerStoreChange() {
      return subscriber;
    },
    get triggerHydration() {
      return finishHydration;
    },
  };
}

describe('initNetworkPolicySync', () => {
  it('does nothing on web (isElectron false)', async () => {
    const { initNetworkPolicySync, setExecutionPolicyMock } = await load(false, {});
    initNetworkPolicySync();
    expect(setExecutionPolicyMock).not.toHaveBeenCalled();
  });

  it('pushes the safe defaults when the settings are unset', async () => {
    const { initNetworkPolicySync, setExecutionPolicyMock } = await load(true, {});
    initNetworkPolicySync();
    expect(setExecutionPolicyMock).toHaveBeenCalledWith({
      allowLocalhost: true,
      allowPrivateIPs: false,
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      defaultTimeout: 30000,
      verifySsl: true,
      clientCertificates: [],
      caCertificates: [],
    });
  });

  it('pushes the user policy immediately on Electron', async () => {
    const { initNetworkPolicySync, setExecutionPolicyMock } = await load(true, {
      allowLocalhost: false,
      allowPrivateIPs: true,
      proxy: { enabled: true, type: 'socks5', host: 'proxy.example.test', port: 1080 },
      defaultTimeout: 45_000,
      verifySsl: false,
      clientCertificates: [
        { id: 'host-cert', host: 'api.example.test', cert: { format: 'pfx', pfx: 'base64' } },
      ],
      caCertificates: [{ id: 'host-ca', host: 'api.example.test', pem: 'pem' }],
    });
    initNetworkPolicySync();
    expect(setExecutionPolicyMock).toHaveBeenCalledWith({
      allowLocalhost: false,
      allowPrivateIPs: true,
      proxy: {
        enabled: true,
        type: 'socks5',
        host: 'proxy.example.test',
        port: 1080,
        bypassList: [],
      },
      defaultTimeout: 45_000,
      verifySsl: false,
      clientCertificates: [
        { id: 'host-cert', host: 'api.example.test', cert: { format: 'pfx', pfx: 'base64' } },
      ],
      caCertificates: [{ id: 'host-ca', host: 'api.example.test', pem: 'pem' }],
    });
  });

  it('waits for persisted settings rehydration before its first policy push', async () => {
    const result = await load(true, { allowLocalhost: false, allowPrivateIPs: true }, false);
    result.initNetworkPolicySync();

    expect(result.setExecutionPolicyMock).not.toHaveBeenCalled();
    (result.triggerHydration as () => void)();
    expect(result.setExecutionPolicyMock).toHaveBeenCalledWith({
      allowLocalhost: false,
      allowPrivateIPs: true,
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      defaultTimeout: 30000,
      verifySsl: true,
      clientCertificates: [],
      caCertificates: [],
    });
  });

  it('pushes the updated policy when the store changes mid-session', async () => {
    const result = await load(true, { allowLocalhost: true, allowPrivateIPs: false });
    result.initNetworkPolicySync();
    result.setExecutionPolicyMock.mockClear();

    const cb = result.triggerStoreChange as (s: { settings: Settings }) => void;
    cb({ settings: { allowLocalhost: false, allowPrivateIPs: true } });

    expect(result.setExecutionPolicyMock).toHaveBeenCalledWith({
      allowLocalhost: false,
      allowPrivateIPs: true,
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      defaultTimeout: 30000,
      verifySsl: true,
      clientCertificates: [],
      caCertificates: [],
    });
  });

  it('does not push when neither flag changed', async () => {
    const result = await load(true, { allowLocalhost: true, allowPrivateIPs: false });
    result.initNetworkPolicySync();
    result.setExecutionPolicyMock.mockClear();

    const cb = result.triggerStoreChange as (s: { settings: Settings }) => void;
    cb({ settings: { allowLocalhost: true, allowPrivateIPs: false } });

    expect(result.setExecutionPolicyMock).not.toHaveBeenCalled();
  });

  it('re-attempts an identical policy after main rejects an earlier async sync', async () => {
    const rejection = new Error('main process unavailable');
    const setExecutionPolicyMock = vi
      .fn()
      .mockRejectedValueOnce(rejection)
      .mockResolvedValueOnce({ ok: true });
    const reportFailure = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const settings = { allowLocalhost: false, allowPrivateIPs: true };
    const result = await load(true, settings, true, setExecutionPolicyMock);

    result.initNetworkPolicySync();
    await vi.waitFor(() => expect(setExecutionPolicyMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(reportFailure).toHaveBeenCalledWith(expect.any(String), rejection)
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cb = result.triggerStoreChange as (s: { settings: Settings }) => void;
    cb({ settings });

    await vi.waitFor(() => expect(setExecutionPolicyMock).toHaveBeenCalledTimes(2));
    reportFailure.mockRestore();
  });
});
