import { describe, expect, it, vi } from 'vitest';
import { followRedirects } from './redirect-follower';
import type { FetcherRequest, FetcherResponse } from './types';

const start = (): FetcherRequest => ({
  url: 'https://api.example.com/start',
  method: 'GET',
  headers: {},
  body: undefined,
  signal: new AbortController().signal,
});

function response(status: number, headers: Record<string, string>, onCancel: () => void) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('hop body'));
    },
    cancel: onCancel,
  });
  const res: FetcherResponse = {
    status,
    statusText: '',
    headers,
    text: async () => 'hop body',
    contentLengthHeader: null,
    body,
  };
  return res;
}

describe('followRedirects releases intermediate hop bodies', () => {
  it('cancels each redirect response body before fetching the next hop', async () => {
    const cancels = [vi.fn(), vi.fn(), vi.fn()];
    const order: string[] = [];
    const fetcher = vi.fn(async (req: FetcherRequest) => {
      order.push(`fetch ${req.url}`);
      const hop = fetcher.mock.calls.length - 1;
      const cancel = () => {
        order.push(`cancel ${hop}`);
        cancels[hop]?.();
      };
      return hop < 2
        ? response(302, { location: `https://api.example.com/hop${hop + 1}` }, cancel)
        : response(200, {}, cancel);
    });

    const final = await followRedirects(start(), fetcher, { allowLocalhost: false });

    expect(final.status).toBe(200);
    expect(cancels[0]).toHaveBeenCalledTimes(1);
    expect(cancels[1]).toHaveBeenCalledTimes(1);
    expect(cancels[2]).not.toHaveBeenCalled();
    expect(order).toEqual([
      'fetch https://api.example.com/start',
      'cancel 0',
      'fetch https://api.example.com/hop1',
      'cancel 1',
      'fetch https://api.example.com/hop2',
    ]);
  });

  it('cancels the unreturned 3xx body when the redirect is refused', async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn(async () =>
      response(302, { location: 'http://169.254.169.254/latest/meta-data' }, cancel)
    );
    await expect(followRedirects(start(), fetcher, { allowLocalhost: false })).rejects.toThrow(
      /Redirect blocked/
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
