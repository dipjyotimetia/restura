import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type { Response as ApiResponse } from '@/types';
import { ConsoleEntrySchema } from '../store-validators';

type ConsoleEntryResponse = z.infer<typeof ConsoleEntrySchema>['response'];
/**
 * `Response` keys the console schema is missing, or whose (non-nullish) value
 * type doesn't fit the schema's output. Compared per key, Response → schema,
 * so it holds under `exactOptionalPropertyTypes` too (Zod infers optionals as
 * `T | undefined`).
 */
type ConsoleResponseDrift = {
  [K in keyof ApiResponse]-?: K extends keyof ConsoleEntryResponse
    ? NonNullable<ApiResponse[K]> extends NonNullable<ConsoleEntryResponse[K]>
      ? never
      : K
    : K;
}[keyof ApiResponse];
describe('ConsoleEntrySchema — response fields survive rehydrate validation', () => {
  it('covers every Response field (compile-time: tsc names the drifting key)', () => {
    // The store keeps the parsed copy, so a `Response` field missing from the
    // schema is stripped on every reload.
    expectTypeOf<ConsoleResponseDrift>().toEqualTypeOf<never>();
  });

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
