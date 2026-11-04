// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../security/secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown): string | undefined =>
    typeof v === 'string' ? v : undefined,
}));
vi.mock('../security/external-secret-providers', () => ({
  desktopExternalSecretResolver: vi.fn(),
}));

import { materializeHttpAuth } from '../security/http-auth-materializer';

describe('materializeHttpAuth — header merge', () => {
  it('replaces a user header of the same name in any casing (one header on the wire)', async () => {
    const out = await materializeHttpAuth({
      auth: { type: 'bearer', bearer: { token: 'from-auth-tab' } } as never,
      headers: { authorization: 'Bearer from-header-row', 'X-Other': '1' },
    });
    expect(out.headers).toEqual({ Authorization: 'Bearer from-auth-tab', 'X-Other': '1' });

    const apiKey = await materializeHttpAuth({
      auth: { type: 'api-key', apiKey: { key: 'X-API-Key', value: 'new', in: 'header' } } as never,
      headers: { 'x-api-key': 'old' },
    });
    expect(apiKey.headers).toEqual({ 'X-API-Key': 'new' });
  });
});
