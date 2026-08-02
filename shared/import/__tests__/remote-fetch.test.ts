import { describe, expect, it, vi } from 'vitest';
import { fetchRemoteImport } from '../remote-fetch';

describe('fetchRemoteImport', () => {
  it('fetches HTTPS text content with a bounded, credential-free request', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response('{"info":{"name":"Example"}}', {
        headers: { 'content-type': 'application/json', 'content-length': '27' },
      })
    );
    const guard = vi.fn().mockResolvedValue(undefined);

    const result = await fetchRemoteImport('https://example.com/collection.json', {
      fetcher,
      guard,
    });

    expect(result).toMatchObject({
      text: '{"info":{"name":"Example"}}',
      contentType: 'application/json',
      finalUrl: 'https://example.com/collection.json',
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://example.com/collection.json',
      expect.objectContaining({ method: 'GET', redirect: 'manual' })
    );
    expect(guard).toHaveBeenCalledWith('example.com');
  });

  it('blocks credentials and private/local URLs before attempting a fetch', async () => {
    const fetcher = vi.fn();

    await expect(fetchRemoteImport('https://user:pass@example.com/a', { fetcher })).rejects.toThrow(
      /credentials/i
    );
    await expect(fetchRemoteImport('https://127.0.0.1/a', { fetcher })).rejects.toThrow(
      /private|local/i
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('revalidates every redirect target and caps the decoded response', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('', { status: 302, headers: { location: 'https://next.example/x' } })
      )
      .mockResolvedValueOnce(new Response('ok', { headers: { 'content-type': 'text/plain' } }));
    const guard = vi.fn().mockResolvedValue(undefined);
    const result = await fetchRemoteImport('https://example.com/a', { fetcher, guard });

    expect(result.finalUrl).toBe('https://next.example/x');
    expect(guard).toHaveBeenNthCalledWith(1, 'example.com');
    expect(guard).toHaveBeenNthCalledWith(2, 'next.example');

    await expect(
      fetchRemoteImport('https://example.com/too-big', {
        fetcher: vi
          .fn()
          .mockResolvedValue(
            new Response('too big', { headers: { 'content-length': '10485761' } })
          ),
      })
    ).rejects.toThrow(/too large/i);
  });
});
