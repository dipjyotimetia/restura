import type { Fetcher, FetcherRequest } from '@shared/protocol/types';
import type { AuthConfig, HttpRequest } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { executeHttp } from '../http';

function captureFetcher(): { fetcher: Fetcher; sent: FetcherRequest[] } {
  const sent: FetcherRequest[] = [];
  const fetcher: Fetcher = async (req) => {
    sent.push(req);
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  return { fetcher, sent };
}

function headerOf(req: FetcherRequest | undefined, name: string): string | undefined {
  if (!req) return undefined;
  const h = req.headers;
  if (h instanceof Headers) return h.get(name) ?? undefined;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
}

async function run(auth: AuthConfig, vars: Record<string, string>) {
  const { fetcher, sent } = captureFetcher();
  const request: HttpRequest = {
    id: 'r',
    name: 'r',
    type: 'http',
    method: 'GET',
    url: 'https://api.example.com/x',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth,
  };
  const outcome = await executeHttp(
    { relativePath: 'r', folderPath: [], type: 'http', request },
    { vars, timeoutMs: 5000, allowLocalhost: false, fetcher }
  );
  return { outcome, sent };
}

describe('executeHttp — auth {{vars}}', () => {
  it('resolves a bearer token template', async () => {
    const { sent } = await run({ type: 'bearer', bearer: { token: '{{tok}}' } }, { tok: 'x' });
    expect(headerOf(sent[0], 'authorization')).toBe('Bearer x');
  });

  it('resolves basic and api-key (query) credentials', async () => {
    const basic = await run(
      { type: 'basic', basic: { username: '{{u}}', password: '{{p}}' } },
      { u: 'alice', p: 'pw' }
    );
    expect(headerOf(basic.sent[0], 'authorization')).toBe(
      `Basic ${Buffer.from('alice:pw').toString('base64')}`
    );
    const apiKey = await run(
      { type: 'api-key', apiKey: { key: 'k', value: '{{tok}}', in: 'query' } },
      { tok: 'x' }
    );
    expect(apiKey.sent[0]?.url).toContain('k=x');
  });

  it('resolves sign-at-wire (WSSE) credentials before signing', async () => {
    const { sent } = await run(
      {
        type: 'wsse',
        wsse: { username: '{{u}}', password: '{{p}}', passwordType: 'PasswordText' },
      },
      { u: 'alice', p: 'pw' }
    );
    const wsse = headerOf(sent[0], 'x-wsse') ?? '';
    expect(wsse).toContain('Username="alice"');
    expect(wsse).not.toContain('{{');
  });
});
