import { describe, it, expect, vi, beforeEach } from 'vitest';

// Each test gets a fresh module instance so the module-level `consentSubscribed`
// flag doesn't bleed between cases. The pattern: resetModules in beforeEach,
// then dynamically import the subject and its deps inside each test.

beforeEach(() => {
  vi.resetModules();
});

async function load(isElectronValue: boolean, errorsEnabled: boolean) {
  let subscriber: ((s: { settings: { telemetry?: { errorsEnabled?: boolean } } }) => void) | null =
    null;

  vi.doMock('@/lib/shared/platform', () => ({
    isElectron: () => isElectronValue,
  }));

  const setConsentMock = vi.fn().mockResolvedValue({ ok: true });
  vi.doMock('@/store/useSettingsStore', () => ({
    useSettingsStore: {
      getState: () => ({ settings: { telemetry: { errorsEnabled } } }),
      subscribe: (cb: typeof subscriber) => {
        subscriber = cb;
        return () => {};
      },
    },
  }));

  vi.doMock('@sentry/electron/renderer', () => ({ init: vi.fn() }));

  // Expose setConsent on window.electron before import
  Object.defineProperty(globalThis, 'window', {
    value: {
      electron: { telemetry: { setConsent: setConsentMock } },
    },
    writable: true,
    configurable: true,
  });

  const { initElectronSentry } = await import('./electron-sentry');
  // `subscriber` is set during initElectronSentry() — return via getter so
  // callers see the post-init value rather than the pre-init null.
  return {
    initElectronSentry,
    setConsentMock,
    get triggerStoreChange() {
      return subscriber;
    },
  };
}

describe('initElectronSentry', () => {
  it('does nothing on web (isElectron false)', async () => {
    const { initElectronSentry, setConsentMock } = await load(false, true);
    await initElectronSentry();
    expect(setConsentMock).not.toHaveBeenCalled();
  });

  it('pushes current consent to main immediately on Electron', async () => {
    const { initElectronSentry, setConsentMock } = await load(true, true);
    await initElectronSentry();
    expect(setConsentMock).toHaveBeenCalledWith(true);
  });

  it('pushes false when errorsEnabled is false', async () => {
    const { initElectronSentry, setConsentMock } = await load(true, false);
    await initElectronSentry();
    expect(setConsentMock).toHaveBeenCalledWith(false);
  });

  it('pushes updated consent when the store changes mid-session', async () => {
    const result = await load(true, true);
    await result.initElectronSentry();
    result.setConsentMock.mockClear();

    // Simulate the user toggling the setting off in SettingsDrawer.
    // Access triggerStoreChange AFTER init so the getter returns the subscriber
    // that subscribeConsent() registered during initElectronSentry().
    const cb = result.triggerStoreChange as (s: {
      settings: { telemetry?: { errorsEnabled?: boolean } };
    }) => void;
    cb({ settings: { telemetry: { errorsEnabled: false } } });

    expect(result.setConsentMock).toHaveBeenCalledWith(false);
  });

  it('does not push consent when the value has not changed', async () => {
    const result = await load(true, true);
    await result.initElectronSentry();
    result.setConsentMock.mockClear();

    const cb = result.triggerStoreChange as (s: {
      settings: { telemetry?: { errorsEnabled?: boolean } };
    }) => void;
    cb({ settings: { telemetry: { errorsEnabled: true } } });

    expect(result.setConsentMock).not.toHaveBeenCalled();
  });
});
