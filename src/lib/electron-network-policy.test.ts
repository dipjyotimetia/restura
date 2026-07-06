import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirrors electron-sentry.test.ts: fresh module per test (the module-level
// `subscribed` flag must not bleed), deps mocked, subscriber captured.

beforeEach(() => {
  vi.resetModules();
});

interface Settings {
  allowLocalhost?: boolean;
  allowPrivateIPs?: boolean;
}

async function load(isElectronValue: boolean, settings: Settings) {
  let subscriber: ((s: { settings: Settings }) => void) | null = null;

  vi.doMock('@/lib/shared/platform', () => ({ isElectron: () => isElectronValue }));

  const setNetworkPolicyMock = vi.fn().mockResolvedValue({ ok: true });
  vi.doMock('@/store/useSettingsStore', () => ({
    useSettingsStore: {
      getState: () => ({ settings }),
      subscribe: (cb: typeof subscriber) => {
        subscriber = cb;
        return () => {};
      },
    },
  }));

  Object.defineProperty(globalThis, 'window', {
    value: { electron: { security: { setNetworkPolicy: setNetworkPolicyMock } } },
    writable: true,
    configurable: true,
  });

  const { initNetworkPolicySync } = await import('./electron-network-policy');
  return {
    initNetworkPolicySync,
    setNetworkPolicyMock,
    get triggerStoreChange() {
      return subscriber;
    },
  };
}

describe('initNetworkPolicySync', () => {
  it('does nothing on web (isElectron false)', async () => {
    const { initNetworkPolicySync, setNetworkPolicyMock } = await load(false, {});
    initNetworkPolicySync();
    expect(setNetworkPolicyMock).not.toHaveBeenCalled();
  });

  it('pushes the safe defaults when the settings are unset', async () => {
    const { initNetworkPolicySync, setNetworkPolicyMock } = await load(true, {});
    initNetworkPolicySync();
    expect(setNetworkPolicyMock).toHaveBeenCalledWith({
      allowLocalhost: true,
      allowPrivateIPs: false,
    });
  });

  it('pushes the user policy immediately on Electron', async () => {
    const { initNetworkPolicySync, setNetworkPolicyMock } = await load(true, {
      allowLocalhost: false,
      allowPrivateIPs: true,
    });
    initNetworkPolicySync();
    expect(setNetworkPolicyMock).toHaveBeenCalledWith({
      allowLocalhost: false,
      allowPrivateIPs: true,
    });
  });

  it('pushes the updated policy when the store changes mid-session', async () => {
    const result = await load(true, { allowLocalhost: true, allowPrivateIPs: false });
    result.initNetworkPolicySync();
    result.setNetworkPolicyMock.mockClear();

    const cb = result.triggerStoreChange as (s: { settings: Settings }) => void;
    cb({ settings: { allowLocalhost: false, allowPrivateIPs: true } });

    expect(result.setNetworkPolicyMock).toHaveBeenCalledWith({
      allowLocalhost: false,
      allowPrivateIPs: true,
    });
  });

  it('does not push when neither flag changed', async () => {
    const result = await load(true, { allowLocalhost: true, allowPrivateIPs: false });
    result.initNetworkPolicySync();
    result.setNetworkPolicyMock.mockClear();

    const cb = result.triggerStoreChange as (s: { settings: Settings }) => void;
    cb({ settings: { allowLocalhost: true, allowPrivateIPs: false } });

    expect(result.setNetworkPolicyMock).not.toHaveBeenCalled();
  });
});
