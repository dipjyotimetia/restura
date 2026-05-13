import { describe, it, expect, vi } from 'vitest';
import { executeHttpProxy } from '../http-proxy';
import type { Fetcher } from '../types';

describe('executeHttpProxy redirect handling', () => {
  it('rejects redirect to private IP', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValueOnce({
      status: 302,
      statusText: 'Found',
      headers: new Headers({ Location: 'http://169.254.169.254/latest/meta-data/' }),
      text: async () => '',
      contentLengthHeader: '0',
      body: null,
    });

    const result = await executeHttpProxy(
      { method: 'GET', url: 'https://attacker.example/redirect' },
      fetcher,
      { allowLocalhost: false }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.payload.error).toMatch(/redirect.*private/i);
      expect(result.status).toBe(400);
    }
  });

  it('rejects redirect to localhost in production mode', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValueOnce({
      status: 301,
      statusText: 'Moved Permanently',
      headers: new Headers({ Location: 'http://localhost:6443/api' }),
      text: async () => '',
      contentLengthHeader: '0',
      body: null,
    });

    const result = await executeHttpProxy(
      { method: 'GET', url: 'https://attacker.example/' },
      fetcher,
      { allowLocalhost: false }
    );

    expect(result.ok).toBe(false);
  });

  it('strips Authorization on cross-origin redirect', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({
        status: 302,
        statusText: 'Found',
        headers: new Headers({ Location: 'https://other.example/api' }),
        text: async () => '',
        contentLengthHeader: '0',
        body: null,
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: async () => 'ok',
        contentLengthHeader: '2',
        body: null,
      });

    await executeHttpProxy(
      {
        method: 'GET',
        url: 'https://api.example/v1/resource',
        headers: { Authorization: 'Bearer secret', Cookie: 'session=x' },
      },
      fetcher as Fetcher,
      { allowLocalhost: false }
    );

    const secondCall = fetcher.mock.calls[1]![0];
    expect(secondCall.headers.has('authorization')).toBe(false);
    expect(secondCall.headers.has('cookie')).toBe(false);
  });

  it('caps redirect chain at 5 hops', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValue({
      status: 302,
      statusText: 'Found',
      headers: new Headers({ Location: 'https://api.example/loop' }),
      text: async () => '',
      contentLengthHeader: '0',
      body: null,
    });

    const result = await executeHttpProxy(
      { method: 'GET', url: 'https://api.example/loop' },
      fetcher,
      { allowLocalhost: false }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.payload.error).toMatch(/too many redirects/i);
  });
});
