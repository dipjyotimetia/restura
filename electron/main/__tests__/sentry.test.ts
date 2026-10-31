import './setup';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

// @sentry/electron/main is mocked so init() records the options object — we then
// exercise the captured beforeSend directly.
const { setSessionMock, getSessionMock, setUserMock } = vi.hoisted(() => ({
  setSessionMock: vi.fn(),
  getSessionMock: vi.fn(),
  setUserMock: vi.fn(),
}));

vi.mock('@sentry/electron/main', () => ({
  init: vi.fn(),
  mainProcessSessionIntegration: vi.fn(() => ({ name: 'MainProcessSession' })),
  getIsolationScope: vi.fn(() => ({ setSession: setSessionMock, getSession: getSessionMock })),
  getCurrentScope: vi.fn(() => ({ setUser: setUserMock })),
  endSession: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
}));

vi.mock('../lifecycle/telemetry-install-id', () => ({
  getOrCreateInstallId: vi.fn(() => 'install-id-under-test'),
  deleteInstallId: vi.fn(),
}));

import * as Sentry from '@sentry/electron/main';
import { initSentry, isSentryEnabled, scrubEvent, setSentryEnabled } from '../lifecycle/sentry';
import { deleteInstallId, getOrCreateInstallId } from '../lifecycle/telemetry-install-id';

const initMock = Sentry.init as unknown as Mock;
const sessionIntegrationMock = Sentry.mainProcessSessionIntegration as unknown as Mock;
const getIdMock = getOrCreateInstallId as unknown as Mock;
const deleteIdMock = deleteInstallId as unknown as Mock;

describe('scrubEvent', () => {
  it('drops request context, server_name, and user identity', () => {
    const out = scrubEvent({
      message: 'boom',
      request: { url: 'https://api.example.com/x', headers: { authorization: 'Bearer abc' } },
      server_name: 'my-machine',
      user: { id: 'abc', ip_address: '1.2.3.4' },
    } as Sentry.Event);
    expect(out.request).toBeUndefined();
    expect(out.server_name).toBeUndefined();
    expect(out.user).toBeUndefined();
  });

  it('redacts secrets in message and exception values', () => {
    const out = scrubEvent({
      message: 'failed with token sk-ant-0123456789abcdef0123',
      exception: {
        values: [{ type: 'Error', value: 'Authorization: Bearer abcdef0123456789' }],
      },
    } as Sentry.Event);
    expect(out.message).not.toContain('sk-ant-');
    expect(out.message).toContain('[REDACTED]');
    expect(out.exception?.values?.[0]?.value).toContain('[REDACTED]');
  });

  it('scrubs absolute file paths from free-text', () => {
    const out = scrubEvent({
      message: 'ENOENT at /Users/alice/secret/file.txt',
    } as Sentry.Event);
    expect(out.message).not.toContain('/Users/alice');
    expect(out.message).toContain('[path]');
  });

  it('drops stack-frame locals and breadcrumb data', () => {
    const out = scrubEvent({
      exception: {
        values: [
          { stacktrace: { frames: [{ filename: 'app:///index.js', vars: { token: 'secret' } }] } },
        ],
      },
      breadcrumbs: [{ message: 'GET /Users/bob/x', data: { url: 'https://x.test', body: 'y' } }],
    } as Sentry.Event);
    expect(out.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars).toBeUndefined();
    // filename is preserved for source-map matching.
    expect(out.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename).toBe('app:///index.js');
    expect(out.breadcrumbs?.[0]?.data).toBeUndefined();
    expect(out.breadcrumbs?.[0]?.message).toContain('[path]');
  });
});

describe('opt-in gate', () => {
  beforeEach(() => {
    initMock.mockClear();
    setSentryEnabled(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not init Sentry or create an install id without a DSN', () => {
    getIdMock.mockClear();
    initSentry({ enabled: true, countSessions: true });
    expect(initMock).not.toHaveBeenCalled();
    expect(getIdMock).not.toHaveBeenCalled();
    // ...but the in-memory gate still reflects the requested state.
    expect(isSentryEnabled()).toBe(true);
  });

  it('deletes the install id when launching opted out', () => {
    deleteIdMock.mockClear();
    getIdMock.mockClear();
    initSentry({ enabled: false, countSessions: true });
    expect(deleteIdMock).toHaveBeenCalledTimes(1);
    expect(getIdMock).not.toHaveBeenCalled();
    expect(initMock).not.toHaveBeenCalled();
  });

  it('tracks the enabled flag via setSentryEnabled', () => {
    setSentryEnabled(true);
    expect(isSentryEnabled()).toBe(true);
    setSentryEnabled(false);
    expect(isSentryEnabled()).toBe(false);
  });

  // Runs last: doInit() is one-shot (module-level `initialized`), so this test
  // is the one allowed to actually init. The DSN is read lazily inside doInit,
  // so stubbing the env here is enough — no module re-import needed.
  it('inits when enabled and both gates honour the runtime flag', () => {
    vi.stubEnv('SENTRY_DSN', 'https://examplePublicKey@o0.ingest.sentry.io/0');
    initSentry({ enabled: true, countSessions: true });
    expect(initMock).toHaveBeenCalledTimes(1);

    const opts = initMock.mock.calls[0]![0] as {
      integrations: { name: string }[];
      initialScope: { user?: { id?: string } };
      dataCollection: Record<string, unknown>;
      beforeSend: (e: unknown) => Sentry.Event | null;
      beforeBreadcrumb: (crumb: unknown) => unknown;
    };

    // Release Health session tracking is explicit, and no PII is sent — the
    // documented desktop usage signal.
    expect(opts.integrations.some((i) => i.name === 'MainProcessSession')).toBe(true);
    // A returning install reports at launch, so it counts even if later killed.
    expect(sessionIntegrationMock).toHaveBeenCalledWith({ sendOnCreate: true });
    // initialScope (not setUser after init) because the session integration
    // starts the session during init and reads the user from scope at that point.
    expect(opts.initialScope.user).toEqual({ id: 'install-id-under-test' });
    expect(opts.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
    });

    const crumb = { type: 'navigation', message: 'click' };

    // Both gates pass when enabled.
    expect(opts.beforeSend({ message: 'hi' })).toBeTruthy();
    expect(opts.beforeBreadcrumb(crumb)).toBe(crumb);

    // The install id is for sessions only: errors can't be tied to an install.
    const sent = opts.beforeSend({ message: 'hi', user: { id: 'install-id-under-test' } });
    expect(sent?.user).toBeUndefined();

    // Both gates drop when disabled.
    deleteIdMock.mockClear();
    setSessionMock.mockClear();
    setSentryEnabled(false);
    expect(opts.beforeSend({ message: 'hi' })).toBeNull();
    expect(opts.beforeBreadcrumb(crumb)).toBeNull();

    // beforeSend doesn't gate sessions, so opting out must also drop the live
    // session (or it would still ship with the id at quit) and delete the id.
    expect(setSessionMock).toHaveBeenCalledWith(undefined);
    expect(setUserMock).toHaveBeenCalledWith(null);
    expect(deleteIdMock).toHaveBeenCalledTimes(1);
  });

  // No consent record means the user hasn't had a chance to opt out. Holding the
  // session until quit isn't enough, because the SDK also sends it on the first error.
  it('sets no id and removes the default session before a choice is recorded', async () => {
    vi.stubEnv('SENTRY_DSN', 'https://examplePublicKey@o0.ingest.sentry.io/0');
    initMock.mockClear();
    getIdMock.mockClear();
    sessionIntegrationMock.mockClear();
    vi.resetModules();
    const fresh = await import('../lifecycle/sentry.js');
    fresh.initSentry({ enabled: true, countSessions: false });

    expect(getIdMock).not.toHaveBeenCalled();
    expect(sessionIntegrationMock).not.toHaveBeenCalled();
    const opts = initMock.mock.calls[0]![0] as {
      initialScope: { user?: unknown };
      integrations: (defaults: { name: string }[]) => { name: string }[];
    };
    expect(opts.initialScope.user).toBeUndefined();
    expect(
      opts.integrations([{ name: 'MainProcessSession' }, { name: 'OnUncaughtException' }])
    ).toEqual([{ name: 'OnUncaughtException' }]);
  });

  it('counts sessions after an explicit opt-in during a run', async () => {
    vi.stubEnv('SENTRY_DSN', 'https://examplePublicKey@o0.ingest.sentry.io/0');
    getIdMock.mockClear();
    vi.resetModules();
    const fresh = await import('../lifecycle/sentry.js');
    fresh.initSentry({ enabled: false, countSessions: true });
    fresh.setSentryEnabled(true);
    expect(getIdMock).toHaveBeenCalledTimes(1);
  });

  describe('endSentrySessionForQuit', () => {
    const endSessionMock = Sentry.endSession as unknown as Mock;
    const flushMock = Sentry.flush as unknown as Mock;

    async function loadInitialized() {
      vi.stubEnv('SENTRY_DSN', 'https://examplePublicKey@o0.ingest.sentry.io/0');
      vi.resetModules();
      const fresh = await import('../lifecycle/sentry.js');
      fresh.initSentry({ enabled: true, countSessions: true });
      return fresh;
    }

    beforeEach(() => {
      endSessionMock.mockClear();
      flushMock.mockClear();
      getSessionMock.mockReset();
    });

    it('does nothing when Sentry never started', async () => {
      vi.resetModules();
      const fresh = await import('../lifecycle/sentry.js');
      await fresh.endSentrySessionForQuit();
      expect(endSessionMock).not.toHaveBeenCalled();
      expect(flushMock).not.toHaveBeenCalled();
    });

    it('ends a running session and flushes within a time limit', async () => {
      getSessionMock.mockReturnValue({ status: 'ok' });
      const fresh = await loadInitialized();
      await fresh.endSentrySessionForQuit();
      expect(endSessionMock).toHaveBeenCalledTimes(1);
      expect(flushMock).toHaveBeenCalledWith(2000);
    });

    // A crashed session was already sent, and ending it would overwrite the status.
    it('leaves a session that already ended alone', async () => {
      getSessionMock.mockReturnValue({ status: 'crashed' });
      const fresh = await loadInitialized();
      await fresh.endSentrySessionForQuit();
      expect(endSessionMock).not.toHaveBeenCalled();
    });

    it('sends nothing after a mid-session opt-out dropped the session', async () => {
      getSessionMock.mockReturnValue(undefined);
      const fresh = await loadInitialized();
      await fresh.endSentrySessionForQuit();
      expect(endSessionMock).not.toHaveBeenCalled();
    });

    // main.ts calls app.exit() right after this, so a throw would block quitting.
    it('never rejects, so it cannot stop the app quitting', async () => {
      getSessionMock.mockReturnValue({ status: 'ok' });
      flushMock.mockRejectedValueOnce(new Error('transport down'));
      const fresh = await loadInitialized();
      await expect(fresh.endSentrySessionForQuit()).resolves.toBeUndefined();
    });
  });
});
