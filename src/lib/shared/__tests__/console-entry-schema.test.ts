import { describe, expect, it } from 'vitest';
import { ConsoleEntrySchema } from '../store-validators';

describe('ConsoleEntrySchema — response fields survive rehydrate validation', () => {
  const entry = {
    id: 'e1',
    timestamp: 1,
    request: { method: 'GET', url: 'https://example.com', headers: {} },
    response: {
      id: 'r1',
      requestId: 'q1',
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'image/png' },
      body: 'iVBORw0KGgo=',
      size: 8,
      time: 12,
      timestamp: 1,
      bodyEncoding: 'base64',
      negotiatedAlpn: 'h2',
      bodyNotice: 'Unsupported Content-Encoding: zstd',
      partial: false,
      timings: { dns: 1, connect: 2, ttfb: 5, download: 4 },
      mcpOutcome: 'tool-error',
    },
  };

  it('keeps bodyEncoding, negotiatedAlpn, bodyNotice, partial, timings and mcpOutcome', () => {
    const parsed = ConsoleEntrySchema.safeParse(entry);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.response).toEqual(entry.response);
  });

  it('strips a malformed optional field without dropping the entry', () => {
    const bad = { ...entry, response: { ...entry.response, timings: { ttfb: 'slow' } } };
    const parsed = ConsoleEntrySchema.safeParse(bad);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.response.timings).toBeUndefined();
    expect(parsed.data?.response.bodyEncoding).toBe('base64');
  });
});
