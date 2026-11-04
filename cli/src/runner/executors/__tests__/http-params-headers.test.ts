import type { Fetcher, FetcherRequest } from '@shared/protocol/types';
import type { HttpRequest, KeyValue } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { executeHttp } from '../http';

const row = (key: string, value: string): KeyValue => ({
  id: `${key}-${value}`,
  key,
  value,
  enabled: true,
});

async function send(overrides: Partial<HttpRequest>): Promise<FetcherRequest | undefined> {
  const sent: FetcherRequest[] = [];
  const fetcher: Fetcher = async (req) => {
    sent.push(req);
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
      contentLengthHeader: '0',
    };
  };
  const request: HttpRequest = {
    id: 'r',
    name: 'r',
    type: 'http',
    method: 'GET',
    url: 'https://api.example.com/x',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
  await executeHttp(
    { relativePath: 'r', folderPath: [], type: 'http', request },
    { vars: { v: 'b' }, timeoutMs: 5000, allowLocalhost: false, fetcher }
  );
  return sent[0];
}

describe('executeHttp — repeated params and headers (parity with the app)', () => {
  it('keeps repeated query params in order and sends values as typed', async () => {
    const req = await send({
      params: [row('tag', 'a'), row('tag', '{{v}}'), row('q', 'a+b c')],
    });
    expect(req?.url).toBe('https://api.example.com/x?tag=a&tag=b&q=a+b%20c');
  });

  it('combines repeated header rows', async () => {
    const req = await send({ headers: [row('X-Multi', 'a'), row('X-Multi', 'b')] });
    const headers = req?.headers as Record<string, string>;
    expect(headers['X-Multi']).toBe('a, b');
  });
});
