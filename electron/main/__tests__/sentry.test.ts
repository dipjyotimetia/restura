import './setup';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// @sentry/electron/main is mocked so init() records the options object — we then
// exercise the captured beforeSend directly.
vi.mock('@sentry/electron/main', () => ({
  init: vi.fn(),
  mainProcessSessionIntegration: vi.fn(() => ({ name: 'MainProcessSession' })),
}));

import * as Sentry from '@sentry/electron/main';
import { scrubEvent, initSentry, setSentryEnabled, isSentryEnabled } from '../lifecycle/sentry';

const initMock = Sentry.init as unknown as Mock;

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

  it('does not init Sentry without a DSN', () => {
    initSentry({ enabled: true });
    expect(initMock).not.toHaveBeenCalled();
    // ...but the in-memory gate still reflects the requested state.
    expect(isSentryEnabled()).toBe(true);
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
    initSentry({ enabled: true });
    expect(initMock).toHaveBeenCalledTimes(1);

    const opts = initMock.mock.calls[0]![0] as {
      integrations: { name: string }[];
      sendDefaultPii: boolean;
      beforeSend: (e: unknown) => unknown;
      beforeBreadcrumb: (crumb: unknown) => unknown;
    };

    // Release Health session tracking is explicit, and no PII is sent — the
    // documented desktop usage signal.
    expect(opts.integrations.some((i) => i.name === 'MainProcessSession')).toBe(true);
    expect(opts.sendDefaultPii).toBe(false);

    const crumb = { type: 'navigation', message: 'click' };

    // Both gates pass when enabled.
    expect(opts.beforeSend({ message: 'hi' })).toBeTruthy();
    expect(opts.beforeBreadcrumb(crumb)).toBe(crumb);

    // Both gates drop when disabled.
    setSentryEnabled(false);
    expect(opts.beforeSend({ message: 'hi' })).toBeNull();
    expect(opts.beforeBreadcrumb(crumb)).toBeNull();
  });
});
