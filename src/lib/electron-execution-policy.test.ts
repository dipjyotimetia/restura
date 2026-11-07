import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.useRealTimers();
});

interface Settings {
  proxy?: Record<string, unknown>;
  defaultTimeout?: number;
  verifySsl?: boolean;
  allowLocalhost?: boolean;
  allowPrivateIPs?: boolean;
  serverCipherOrder?: boolean;
  minTlsVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
  cipherSuites?: string;
  clientCert?: Record<string, unknown>;
  caCert?: Record<string, unknown>;
  clientCertificates?: Array<Record<string, unknown>>;
  caCertificates?: Array<Record<string, unknown>>;
}

async function load(options: { isElectron: boolean; settings: Settings; hydrated: boolean }) {
  let subscriber: ((state: { settings: Settings }) => void) | null = null;
  let finishHydration: (() => void) | null = null;
  const setExecutionPolicyMock = vi.fn().mockResolvedValue({ ok: true });

  vi.doMock('@/lib/shared/platform', () => ({ isElectron: () => options.isElectron }));
  vi.doMock('@/store/useSettingsStore', () => ({
    useSettingsStore: {
      getState: () => ({ settings: options.settings }),
      subscribe: (callback: typeof subscriber) => {
        subscriber = callback;
        return () => {};
      },
      persist: {
        hasHydrated: () => options.hydrated,
        rehydrate: vi.fn(),
        onFinishHydration: (callback: typeof finishHydration) => {
          finishHydration = callback;
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

  const module = await import('./electron-execution-policy');
  return {
    ...module,
    setExecutionPolicyMock,
    finishHydration: () => finishHydration?.(),
    triggerStoreChange: (settings: Settings) => subscriber?.({ settings }),
  };
}

describe('initExecutionPolicySync', () => {
  it('does nothing on web', async () => {
    const sync = await load({ isElectron: false, settings: {}, hydrated: true });
    await sync.initExecutionPolicySync();
    expect(sync.setExecutionPolicyMock).not.toHaveBeenCalled();
    expect(sync.getExecutionPolicySyncState()).toBe('unavailable');
  });

  it('waits for settings hydration before delivering the full execution policy', async () => {
    const handle = { kind: 'handle', id: 'cert-secret', label: 'Certificate passphrase' };
    const sync = await load({
      isElectron: true,
      hydrated: false,
      settings: {
        allowLocalhost: false,
        allowPrivateIPs: true,
        defaultTimeout: 45_000,
        verifySsl: false,
        serverCipherOrder: true,
        minTlsVersion: 'TLSv1.2',
        cipherSuites: 'HIGH:!aNULL',
        proxy: {
          enabled: true,
          type: 'https',
          host: 'proxy.example.test',
          port: 8443,
          bypassList: ['localhost'],
          auth: { username: 'proxy-user', password: handle },
        },
        clientCert: { format: 'pfx', pfx: 'cGZ4', passphrase: handle },
        caCert: { pem: 'CA-PEM' },
        clientCertificates: [
          {
            id: 'client-1',
            host: '*.example.test',
            cert: { format: 'pem', cert: 'CERT', key: 'KEY' },
          },
        ],
        caCertificates: [{ id: 'ca-1', host: 'api.example.test', pem: 'HOST-CA' }],
      },
    });
    const started = sync.initExecutionPolicySync();
    expect(sync.setExecutionPolicyMock).not.toHaveBeenCalled();
    expect(sync.getExecutionPolicySyncState()).toBe('waiting-for-hydration');
    sync.finishHydration();
    await started;
    expect(sync.setExecutionPolicyMock).toHaveBeenCalledWith({
      security: { allowLocalhost: false, allowPrivateIPs: true },
      proxy: {
        enabled: true,
        type: 'https',
        host: 'proxy.example.test',
        port: 8443,
        bypassList: ['localhost'],
        auth: { username: 'proxy-user', password: handle },
      },
      timeout: 45_000,
      tls: {
        verifySsl: false,
        serverCipherOrder: true,
        minTlsVersion: 'TLSv1.2',
        cipherSuites: 'HIGH:!aNULL',
      },
      certificates: {
        clientCert: { format: 'pfx', pfx: 'cGZ4', passphrase: handle },
        caCert: { pem: 'CA-PEM' },
        clientCertificates: [
          {
            id: 'client-1',
            host: '*.example.test',
            cert: { format: 'pem', cert: 'CERT', key: 'KEY' },
          },
        ],
        caCertificates: [{ id: 'ca-1', host: 'api.example.test', pem: 'HOST-CA' }],
      },
    });
    expect(sync.getExecutionPolicySyncState()).toBe('acknowledged');
  });

  it('retries a rejected delivery and becomes acknowledged after the retry', async () => {
    vi.useFakeTimers();
    const sync = await load({ isElectron: true, settings: {}, hydrated: true });
    sync.setExecutionPolicyMock.mockRejectedValueOnce(new Error('main unavailable'));
    await sync.initExecutionPolicySync();
    expect(sync.setExecutionPolicyMock).toHaveBeenCalledTimes(1);
    expect(sync.getExecutionPolicySyncState()).toBe('retrying');
    await vi.advanceTimersByTimeAsync(250);
    expect(sync.setExecutionPolicyMock).toHaveBeenCalledTimes(2);
    expect(sync.getExecutionPolicySyncState()).toBe('acknowledged');
  });

  it('does not let a failed delivery overwrite a newer policy queued while it was in flight', async () => {
    vi.useFakeTimers();
    const sync = await load({ isElectron: true, settings: {}, hydrated: true });
    let rejectFirst: (error: Error) => void = () => {};
    sync.setExecutionPolicyMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        })
    );
    const init = sync.initExecutionPolicySync();
    await vi.waitFor(() => expect(sync.setExecutionPolicyMock).toHaveBeenCalledTimes(1));
    // A newer settings snapshot arrives while the first delivery is in flight.
    sync.triggerStoreChange({ allowLocalhost: false, defaultTimeout: 42_000 });
    rejectFirst(new Error('main unavailable'));
    await init;
    expect(sync.getExecutionPolicySyncState()).toBe('retrying');
    await vi.advanceTimersByTimeAsync(250);
    expect(sync.setExecutionPolicyMock).toHaveBeenCalledTimes(2);
    expect(sync.setExecutionPolicyMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeout: 42_000 })
    );
    expect(sync.getExecutionPolicySyncState()).toBe('acknowledged');
  });

  it('backs off between repeated rejected deliveries', async () => {
    vi.useFakeTimers();
    const sync = await load({ isElectron: true, settings: {}, hydrated: true });
    sync.setExecutionPolicyMock
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'));
    await sync.initExecutionPolicySync();
    await vi.advanceTimersByTimeAsync(250);
    expect(sync.setExecutionPolicyMock).toHaveBeenCalledTimes(2);
    // Second retry waits longer than the first.
    await vi.advanceTimersByTimeAsync(250);
    expect(sync.setExecutionPolicyMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(sync.setExecutionPolicyMock).toHaveBeenCalledTimes(3);
    expect(sync.getExecutionPolicySyncState()).toBe('acknowledged');
  });

  it('synchronizes a changed settings snapshot after acknowledgement', async () => {
    const sync = await load({ isElectron: true, settings: {}, hydrated: true });
    await sync.initExecutionPolicySync();
    sync.setExecutionPolicyMock.mockClear();
    sync.triggerStoreChange({ allowLocalhost: false, defaultTimeout: 10_000 });
    await vi.waitFor(() => expect(sync.setExecutionPolicyMock).toHaveBeenCalledTimes(1));
    expect(sync.setExecutionPolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        security: { allowLocalhost: false, allowPrivateIPs: false },
        timeout: 10_000,
      })
    );
  });
});
