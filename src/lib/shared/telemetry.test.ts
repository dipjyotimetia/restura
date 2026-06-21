import { describe, it, expect, vi, beforeEach } from 'vitest';

// Worker base must be non-empty so reportError proceeds to send.
vi.mock('@/lib/shared/platform', () => ({
  workerBaseUrl: () => 'https://api.test',
  workerAuthHeaders: () => ({}),
}));

// Telemetry on (opt-out default) so the report fires.
vi.mock('@/store/useSettingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ settings: { telemetry: { errorsEnabled: true } } }),
  },
}));

import { reportError } from './telemetry';

describe('reportError redaction', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts secrets from message and stack before sending', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    // source 'error-boundary' takes the fetch path (sendBeacon is skipped for it).
    reportError({
      message: 'failed with token sk-ant-0123456789abcdef0123',
      stack: 'Error: Authorization: Bearer abcdef0123456789\n  at handler',
      source: 'error-boundary',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string) as { message: string; stack: string };
    expect(body.message).not.toContain('sk-ant-');
    expect(body.message).toContain('[REDACTED]');
    expect(body.stack).not.toContain('abcdef0123456789');
    expect(body.stack).toContain('[REDACTED]');
  });

  it('does not send when telemetry payload is clean (no false redaction)', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    reportError({ message: 'plain render error', source: 'error-boundary' });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string) as { message: string };
    expect(body.message).toBe('plain render error');
  });
});
