// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { makeFetchFetcher } from '../fetch-fetcher';

function fakeResponse(over: Partial<Response> = {}): Response {
  return {
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-length': '5' }),
    body: null,
    text: async () => 'hello',
    ...over,
  } as unknown as Response;
}

describe('makeFetchFetcher', () => {
  it('maps a native fetch response to the FetcherResponse shape', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse());
    const fetcher = makeFetchFetcher({ fetchImpl: fetchImpl as never });

    const res = await fetcher({
      method: 'GET',
      url: 'https://example.com',
      headers: { Accept: 'text/event-stream' },
    } as never);

    expect(res.status).toBe(200);
    expect(res.statusText).toBe('OK');
    expect(res.contentLengthHeader).toBe('5');
    expect(await res.text()).toBe('hello');
  });

  it('forwards method, headers, body and signal to the underlying fetch', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse());
    const fetcher = makeFetchFetcher({ fetchImpl: fetchImpl as never });
    const signal = new AbortController().signal;

    await fetcher({
      method: 'POST',
      url: 'https://api/x',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
      signal,
    } as never);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api/x',
      expect.objectContaining({
        method: 'POST',
        body: '{"a":1}',
        signal,
        redirect: 'follow',
      })
    );
  });

  it('defaults redirect to "follow" and honours an explicit "manual"', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => fakeResponse());

    await makeFetchFetcher({ fetchImpl: fetchImpl as never })({
      method: 'GET',
      url: 'https://x',
      headers: {},
    } as never);
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: 'follow' });

    await makeFetchFetcher({ redirect: 'manual', fetchImpl: fetchImpl as never })({
      method: 'GET',
      url: 'https://x',
      headers: {},
    } as never);
    expect(fetchImpl.mock.calls[1]![1]).toMatchObject({ redirect: 'manual' });
  });

  it('maps a missing content-length header to null', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ headers: new Headers() }));
    const res = await makeFetchFetcher({ fetchImpl: fetchImpl as never })({
      method: 'GET',
      url: 'https://x',
      headers: {},
    } as never);
    expect(res.contentLengthHeader).toBeNull();
  });
});
