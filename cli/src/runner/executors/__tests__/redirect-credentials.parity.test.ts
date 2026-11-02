// Redirect header handling through the CLI's HTTP executor. The table lives in
// shared/protocol/__tests__/redirect-credentials.fixture.ts.
import {
  API_KEY_AUTH,
  KEPT_ON_ORIGIN_CHANGE,
  OTHER_ORIGIN,
  REDIRECT_START,
  SAME_ORIGIN,
  SENT_HEADERS,
  STRIPPED_ON_ORIGIN_CHANGE,
  WSSE_AUTH,
} from '@shared/protocol/__tests__/redirect-credentials.fixture';
import type { Fetcher } from '@shared/protocol/types';
import type { AuthConfig, HttpRequest } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { executeHttp } from '../http';

async function secondHopHeaders(location: string, auth: AuthConfig): Promise<string[]> {
  const seen: Headers[] = [];
  const fetcher: Fetcher = async (req) => {
    seen.push(new Headers(req.headers));
    const status = seen.length === 1 ? 302 : 200;
    const headers: Record<string, string> = status === 302 ? { location } : {};
    return {
      status,
      statusText: '',
      headers,
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  const request: HttpRequest = {
    id: 'r',
    name: 'r',
    type: 'http',
    method: 'GET',
    url: REDIRECT_START,
    headers: Object.entries(SENT_HEADERS).map(([key, value]) => ({
      id: key,
      key,
      value,
      enabled: true,
    })),
    params: [],
    body: { type: 'none' },
    auth,
  };
  await executeHttp(
    { relativePath: 'r', folderPath: [], type: 'http', request },
    { vars: {}, timeoutMs: 5000, allowLocalhost: false, fetcher }
  );
  return [...(seen[1] as Headers).keys()];
}

describe('redirect headers: CLI', () => {
  it('removes credentials on an origin change and keeps the rest', async () => {
    const names = await secondHopHeaders(OTHER_ORIGIN, API_KEY_AUTH);
    for (const name of KEPT_ON_ORIGIN_CHANGE) expect(names).toContain(name);
    for (const name of STRIPPED_ON_ORIGIN_CHANGE) expect(names).not.toContain(name);
  });

  it('removes a header sign-at-wire auth added', async () => {
    const names = await secondHopHeaders(OTHER_ORIGIN, WSSE_AUTH);
    expect(names).not.toContain('x-wsse');
    for (const name of KEPT_ON_ORIGIN_CHANGE) expect(names).toContain(name);
  });

  it('keeps every header on the same origin', async () => {
    const names = await secondHopHeaders(SAME_ORIGIN, API_KEY_AUTH);
    // Proxy-Authorization never goes upstream, on any hop.
    const expected = STRIPPED_ON_ORIGIN_CHANGE.filter((name) => name !== 'proxy-authorization');
    for (const name of [...KEPT_ON_ORIGIN_CHANGE, ...expected]) expect(names).toContain(name);
  });
});
