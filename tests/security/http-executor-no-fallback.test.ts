/**
 * HTTP executor no-direct-fallback regression.
 *
 * The renderer used to fall back to `axios()` directly to upstream when
 * the Electron IPC branch produced a response. That
 * fallback bypassed the Worker's SSRF guard, header policy, auth gate,
 * and rate limiter, and forced the renderer to do sign-at-wire auth
 * (SigV4/OAuth1/WSSE) — which couldn't sign the exact bytes the upstream
 * received because the renderer didn't own body re-encoding.
 *
 * This test stubs `axios` and asserts that in web mode the executor
 * NEVER calls axios against an upstream URL. It may call axios against
 * `/api/proxy` (the Worker), or it may throw a clear error — both
 * outcomes are acceptable. What is not acceptable is silently shipping a
 * raw request to the upstream from the browser.
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { HttpRequest, AppSettings } from '@/types';

vi.mock('axios', async () => {
  const fn = vi.fn(async (_config: unknown) => ({
    status: 200,
    statusText: 'OK',
    headers: {},
    data: '',
  }));
  // requestExecutor uses both `axios(config)` and `axios.post(url, body, opts)`.
  const post = vi.fn(async (_url: string, _body: unknown, _opts: unknown) => ({
    data: {
      status: 200,
      statusText: 'OK',
      headers: {},
      data: '',
      size: 0,
    },
  }));
  const isAxiosError = (e: unknown): boolean =>
    !!(e && typeof e === 'object' && 'isAxiosError' in (e as Record<string, unknown>));
  const axiosMock = Object.assign(fn, { post, isAxiosError });
  return {
    default: axiosMock,
    isAxiosError,
  };
});

import axios from 'axios';
import { executeRequest } from '@/features/http/lib/requestExecutor';

const UPSTREAM = 'https://upstream.example.com/v1/resource';

function makeHttpRequest(): HttpRequest {
  return {
    id: 'test-req',
    name: 'test',
    type: 'http',
    url: UPSTREAM,
    method: 'GET',
    headers: [],
    params: [],
    body: { type: 'none', raw: '' },
    auth: { type: 'none' },
  } as unknown as HttpRequest;
}

function makeSettings(): AppSettings {
  return {
    proxy: { enabled: false, type: 'http', host: '', port: 0 },
    defaultTimeout: 5_000,
    followRedirects: true,
    maxRedirects: 5,
    verifySsl: true,
    autoSaveHistory: false,
    maxHistoryItems: 100,
    theme: 'system',
    layoutOrientation: 'horizontal',
    allowLocalhost: true,
  } as AppSettings;
}

function isUpstreamUrl(input: unknown): boolean {
  if (typeof input !== 'string') return false;
  try {
    const u = new URL(input);
    return u.hostname === 'upstream.example.com';
  } catch {
    return false;
  }
}

describe('HTTP executor no-direct-fallback (security regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT axios() directly to upstream in web mode', async () => {
    const request = makeHttpRequest();
    const settings = makeSettings();

    try {
      await executeRequest({
        request,
        envVars: {},
        globalSettings: settings,
        resolveVariables: (s) => s,
      });
    } catch {
      // An explicit thrown error ("no transport available") is an
      // acceptable outcome — the unacceptable outcome is silently
      // shipping a raw fetch to the upstream.
    }

    // axios(config) — the fallback path. Args[0] is the config object with .url.
    const directCalls = (axios as unknown as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of directCalls) {
      const config = call[0] as { url?: string } | undefined;
      expect(
        !isUpstreamUrl(config?.url),
        `expected no direct upstream call, saw axios(${config?.url})`
      ).toBe(true);
    }

    // axios.post(url, body) — also assert no upstream URL was posted to.
    const postCalls = (axios as unknown as { post: ReturnType<typeof vi.fn> }).post.mock.calls;
    for (const call of postCalls) {
      const url = call[0] as string;
      expect(!isUpstreamUrl(url), `expected proxied URL, saw axios.post(${url})`).toBe(true);
    }
  });
});
