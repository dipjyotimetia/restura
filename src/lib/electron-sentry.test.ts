import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each test gets a fresh module instance so the module-level `consentSubscribed`
// flag doesn't bleed between cases. The pattern: resetModules in beforeEach,
// then dynamically import the subject and its deps inside each test.

beforeEach(() => {
  vi.resetModules();
});

async function load(
  isElectronValue: boolean,
  errorsEnabled: boolean,
  options: { sentryImportFails?: boolean; hydrated?: boolean } = {}
) {
  let subscriber: ((s: { settings: { telemetry?: { errorsEnabled?: boolean } } }) => void) | null =
    null;
  let hydrated = options.hydrated ?? true;
  let finishHydration: (() => void) | null = null;
  let currentEnabled = errorsEnabled;
  const logWarnMock = vi.fn();

  vi.doMock('@/lib/shared/platform', () => ({
    isElectron: () => isElectronValue,
  }));

  vi.doMock('@/lib/shared/logger', () => ({
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: logWarnMock,
      error: vi.fn(),
      child: vi.fn(),
    }),
  }));

  const setConsentMock = vi.fn().mockResolvedValue({ ok: true });
  vi.doMock('@/store/useSettingsStore', () => ({
    useSettingsStore: {
      getState: () => ({ settings: { telemetry: { errorsEnabled: currentEnabled } } }),
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

  if (options.sentryImportFails) {
    vi.doMock('@sentry/electron/renderer', () => ({
      init: () => {
        throw new Error('renderer sdk unavailable');
      },
    }));
  } else {
    vi.doMock('@sentry/electron/renderer', () => ({ init: vi.fn() }));
  }

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
    logWarnMock,
    get triggerStoreChange() {
      return subscriber;
    },
    /** Mimics zustand persist: store update (subscribers), then the finish listeners. */
    finishHydration(persistedEnabled: boolean) {
      if (persistedEnabled !== currentEnabled) {
        currentEnabled = persistedEnabled;
        subscriber?.({ settings: { telemetry: { errorsEnabled: persistedEnabled } } });
      }
      hydrated = true;
      finishHydration?.();
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

  // The pre-hydration value is the default (true), not the user's choice. Pushing
  // it would make main init Sentry and create an install id for someone opted out.
  it('does not push the default before the settings store has hydrated', async () => {
    const result = await load(true, true, { hydrated: false });
    await result.initElectronSentry();
    expect(result.setConsentMock).not.toHaveBeenCalled();
  });

  it('never pushes true for an opted-out user whose settings hydrate late', async () => {
    const result = await load(true, true, { hydrated: false });
    await result.initElectronSentry();
    result.finishHydration(false);
    expect(result.setConsentMock).toHaveBeenCalledTimes(1);
    expect(result.setConsentMock).toHaveBeenCalledWith(false);
  });

  it('pushes true once hydration confirms the user is opted in', async () => {
    const result = await load(true, true, { hydrated: false });
    await result.initElectronSentry();
    result.finishHydration(true);
    expect(result.setConsentMock).toHaveBeenCalledTimes(1);
    expect(result.setConsentMock).toHaveBeenCalledWith(true);
  });

  // Hydration can fail, leaving hasHydrated() false for good. Opting out must
  // still work; opting in stays blocked because that is the safe direction.
  it('honours an opt-out even if hydration never finishes', async () => {
    const result = await load(true, true, { hydrated: false });
    await result.initElectronSentry();
    const cb = result.triggerStoreChange as (s: {
      settings: { telemetry?: { errorsEnabled?: boolean } };
    }) => void;
    cb({ settings: { telemetry: { errorsEnabled: false } } });
    expect(result.setConsentMock).toHaveBeenCalledWith(false);

    result.setConsentMock.mockClear();
    cb({ settings: { telemetry: { errorsEnabled: true } } });
    expect(result.setConsentMock).not.toHaveBeenCalled();
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

  it('logs renderer SDK init failures without blocking consent sync', async () => {
    const result = await load(true, true, { sentryImportFails: true });
    await result.initElectronSentry();

    expect(result.setConsentMock).toHaveBeenCalledWith(true);
    expect(result.logWarnMock).toHaveBeenCalledTimes(1);
    expect(result.logWarnMock.mock.calls[0]?.[0]).toBe('failed to initialize renderer Sentry SDK');
    expect(result.logWarnMock.mock.calls[0]?.[1]).toEqual({ error: 'renderer sdk unavailable' });
  });
});
