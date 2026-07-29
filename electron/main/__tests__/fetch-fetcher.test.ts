import { followRedirects } from '@shared/protocol/redirect-follower';
import type { Fetcher } from '@shared/protocol/types';
import { describe, expect, it, vi } from 'vitest';
import { makeRouteAwareFetcher } from '../handlers/fetch-fetcher';

describe('makeRouteAwareFetcher', () => {
  it('builds a fresh transport for every redirect destination', async () => {
    const routedUrls: string[] = [];
    const firstResponse = {
      status: 302,
      statusText: 'Found',
      headers: new Headers({ location: 'https://proxied.example.test/final' }),
      body: null,
      contentLengthHeader: null,
      text: vi.fn(async () => ''),
    };
    const secondResponse = {
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      body: null,
      contentLengthHeader: null,
      text: vi.fn(async () => 'ok'),
    };
    const routeAware = makeRouteAwareFetcher(async (url) => {
      routedUrls.push(url);
      const fetcher: Fetcher = vi.fn(async () =>
        url.includes('proxied.example.test') ? secondResponse : firstResponse
      );
      return fetcher;
    });

    const response = await followRedirects(
      {
        url: 'https://bypassed.example.test/start',
        method: 'GET',
        headers: {},
        body: undefined,
        signal: new AbortController().signal,
      },
      routeAware,
      { allowLocalhost: false }
    );

    expect(response.status).toBe(200);
    expect(routedUrls).toEqual([
      'https://bypassed.example.test/start',
      'https://proxied.example.test/final',
    ]);
  });
});
