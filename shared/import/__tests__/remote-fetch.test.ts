import { describe, expect, it, vi } from 'vitest';
import { fetchRemoteImport, REMOTE_IMPORT_MAX_BYTES } from '../remote-fetch';

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

  it('rejects malformed redirects, failed statuses, and binary responses', async () => {
    await expect(
      fetchRemoteImport('https://example.com/missing-location', {
        fetcher: vi.fn().mockResolvedValue(new Response('', { status: 302 })),
      })
    ).rejects.toThrow(/Location header/i);

    await expect(
      fetchRemoteImport('https://example.com/not-found', {
        fetcher: vi.fn().mockResolvedValue(new Response('', { status: 404 })),
      })
    ).rejects.toThrow(/HTTP 404/);

    await expect(
      fetchRemoteImport('https://example.com/binary', {
        fetcher: vi.fn().mockResolvedValue(new Response(new Uint8Array([0, 1]), { status: 200 })),
      })
    ).rejects.toThrow(/not binary/i);
  });

  it('bounds streamed responses and redirect chains while accepting empty text artifacts', async () => {
    const overflow = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(REMOTE_IMPORT_MAX_BYTES + 1));
        controller.close();
      },
    });
    await expect(
      fetchRemoteImport('https://example.com/streamed-too-big', {
        fetcher: vi.fn().mockResolvedValue(new Response(overflow)),
      })
    ).rejects.toThrow(/too large/i);

    const redirect = new Response('', { status: 301, headers: { location: '/next' } });
    await expect(
      fetchRemoteImport('https://example.com/redirect-loop', {
        fetcher: vi.fn().mockResolvedValue(redirect),
      })
    ).rejects.toThrow(/too many redirects/i);

    await expect(
      fetchRemoteImport('https://example.com/empty', {
        fetcher: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
      })
    ).resolves.toMatchObject({ text: '', contentType: '' });
  });

  it('maps caller cancellation and its own timeout to stable import errors', async () => {
    const abortingFetcher: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new Error('socket aborted'));
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(new Error('socket aborted')));
      });
    const caller = new AbortController();
    const cancelled = fetchRemoteImport('https://example.com/cancelled', {
      fetcher: abortingFetcher,
      signal: caller.signal,
    });
    const cancelledExpectation = expect(cancelled).rejects.toThrow('Remote import was cancelled.');
    caller.abort();
    await cancelledExpectation;

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      fetchRemoteImport('https://example.com/already-cancelled', {
        fetcher: abortingFetcher,
        signal: alreadyAborted.signal,
      })
    ).rejects.toThrow('Remote import was cancelled.');

    vi.useFakeTimers();
    const timedOut = fetchRemoteImport('https://example.com/timed-out', {
      fetcher: abortingFetcher,
    });
    const timeoutExpectation = expect(timedOut).rejects.toThrow('Remote import timed out.');
    await vi.advanceTimersByTimeAsync(30_000);
    await timeoutExpectation;
    vi.useRealTimers();
  });
});
