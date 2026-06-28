import { describe, it, expect } from 'vitest';
import {
  entriesToHar,
  entriesToNdjson,
  entriesToCurlBatch,
  buildExportFile,
} from '../console-export';
import type { ConsoleEntry } from '@/store/useConsoleStore';

const makeEntry = (overrides: Partial<ConsoleEntry> = {}): ConsoleEntry => ({
  id: 'e1',
  timestamp: 1_700_000_000_000,
  protocol: 'http',
  request: {
    method: 'GET',
    url: 'https://api.example.com/users?page=2&limit=10',
    headers: { 'Content-Type': 'application/json', 'X-Token': 'abc' },
  },
  response: {
    id: 'r1',
    requestId: 'req-1',
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    body: '{"ok":true}',
    size: 11,
    time: 42,
    timestamp: 1_700_000_000_010,
  },
  ...overrides,
});

describe('entriesToHar', () => {
  it('emits HAR 1.2 envelope with required top-level fields', () => {
    const har = entriesToHar([makeEntry()]);
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator.name).toBe('Restura');
    expect(har.log.entries).toHaveLength(1);
  });

  it('expands a single header value into one HarHeader', () => {
    const har = entriesToHar([makeEntry()]);
    const reqHeaders = har.log.entries[0]!.request.headers;
    expect(reqHeaders).toContainEqual({ name: 'Content-Type', value: 'application/json' });
    expect(reqHeaders).toContainEqual({ name: 'X-Token', value: 'abc' });
  });

  it('expands array-valued response headers into one HarHeader per value', () => {
    const har = entriesToHar([
      makeEntry({
        response: {
          ...makeEntry().response,
          headers: { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] },
        },
      }),
    ]);
    const respHeaders = har.log.entries[0]!.response.headers;
    expect(respHeaders.filter((h) => h.name === 'set-cookie')).toEqual([
      { name: 'set-cookie', value: 'a=1; Path=/' },
      { name: 'set-cookie', value: 'b=2; Path=/' },
    ]);
  });

  it('maps a successful gRPC entry (status 0) to HTTP 200 — HAR treats 0 as no-response', () => {
    const har = entriesToHar([
      makeEntry({ protocol: 'grpc', response: { ...makeEntry().response, status: 0 } }),
    ]);
    expect(har.log.entries[0]!.response.status).toBe(200);
  });

  it('maps a gRPC error code to its HTTP equivalent in HAR', () => {
    const har = entriesToHar([
      makeEntry({ protocol: 'grpc', response: { ...makeEntry().response, status: 5 } }),
    ]);
    expect(har.log.entries[0]!.response.status).toBe(404); // NOT_FOUND
  });

  it('parses URL query parameters into queryString', () => {
    const har = entriesToHar([makeEntry()]);
    expect(har.log.entries[0]!.request.queryString).toEqual([
      { name: 'page', value: '2' },
      { name: 'limit', value: '10' },
    ]);
  });

  it('falls back to empty queryString when the URL is unparseable', () => {
    const har = entriesToHar([
      makeEntry({ request: { ...makeEntry().request, url: 'not-a-real-url' } }),
    ]);
    expect(har.log.entries[0]!.request.queryString).toEqual([]);
  });

  it('omits postData when the request has no body', () => {
    const har = entriesToHar([makeEntry()]);
    expect(har.log.entries[0]!.request.postData).toBeUndefined();
  });

  it('includes postData when the request has a body, using request content-type', () => {
    const har = entriesToHar([
      makeEntry({
        request: {
          ...makeEntry().request,
          method: 'POST',
          body: '{"name":"x"}',
        },
      }),
    ]);
    const postData = har.log.entries[0]!.request.postData;
    expect(postData).toEqual({ mimeType: 'application/json', text: '{"name":"x"}' });
  });

  it('uses response content-type for response.content.mimeType (case-insensitive)', () => {
    const har = entriesToHar([
      makeEntry({
        response: {
          ...makeEntry().response,
          headers: { 'Content-Type': 'application/xml' },
        },
      }),
    ]);
    expect(har.log.entries[0]!.response.content.mimeType).toBe('application/xml');
  });

  it('uses text/plain when content-type is missing', () => {
    const har = entriesToHar([
      makeEntry({
        response: { ...makeEntry().response, headers: {} },
      }),
    ]);
    expect(har.log.entries[0]!.response.content.mimeType).toBe('text/plain');
  });

  it('records timing.wait = response.time so HAR viewers show duration', () => {
    const har = entriesToHar([makeEntry()]);
    expect(har.log.entries[0]!.timings.wait).toBe(42);
    expect(har.log.entries[0]!.time).toBe(42);
  });
});

describe('entriesToNdjson', () => {
  it('emits one JSON line per entry, separated by newline', () => {
    const text = entriesToNdjson([makeEntry({ id: 'a' }), makeEntry({ id: 'b' })]);
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).id).toBe('a');
    expect(JSON.parse(lines[1]!).id).toBe('b');
  });

  it('defaults protocol to "http" when entry has none', () => {
    const entry = makeEntry();
    delete entry.protocol;
    const text = entriesToNdjson([entry]);
    expect(JSON.parse(text).protocol).toBe('http');
  });

  it('omits scriptLogs / tests keys when absent', () => {
    const text = entriesToNdjson([makeEntry()]);
    const parsed = JSON.parse(text);
    expect(parsed).not.toHaveProperty('scriptLogs');
    expect(parsed).not.toHaveProperty('tests');
  });

  it('includes scriptLogs and tests when present', () => {
    const entry = makeEntry({
      scriptLogs: [{ type: 'log', message: 'hi', timestamp: 1 }],
      tests: [{ name: 'status is 200', passed: true }],
    });
    const parsed = JSON.parse(entriesToNdjson([entry]));
    expect(parsed.scriptLogs).toHaveLength(1);
    expect(parsed.tests[0].name).toBe('status is 200');
  });

  it('returns empty string for empty input', () => {
    expect(entriesToNdjson([])).toBe('');
  });
});

describe('entriesToCurlBatch', () => {
  it('emits oldest-first regardless of input order', () => {
    const newest = makeEntry({
      id: 'newest',
      request: { method: 'GET', url: 'https://example.com/newest', headers: {} },
    });
    const oldest = makeEntry({
      id: 'oldest',
      request: { method: 'GET', url: 'https://example.com/oldest', headers: {} },
    });
    // Console stores newest at index 0; batch must reverse to chronological.
    const batch = entriesToCurlBatch([newest, oldest]);
    const oldestIdx = batch.indexOf('oldest');
    const newestIdx = batch.indexOf('newest');
    expect(oldestIdx).toBeGreaterThan(-1);
    expect(newestIdx).toBeGreaterThan(-1);
    expect(oldestIdx).toBeLessThan(newestIdx);
  });

  it('separates each curl block with a blank line', () => {
    const batch = entriesToCurlBatch([makeEntry({ id: 'a' }), makeEntry({ id: 'b' })]);
    expect(batch).toContain('\n\n');
  });
});

describe('buildExportFile', () => {
  it('builds a .har with application/json mime type and stringified HAR', () => {
    const file = buildExportFile('har', [makeEntry()]);
    expect(file.filename).toMatch(/\.har$/);
    expect(file.mimeType).toBe('application/json');
    expect(JSON.parse(file.contents).log.version).toBe('1.2');
  });

  it('builds a .ndjson with application/x-ndjson mime type', () => {
    const file = buildExportFile('ndjson', [makeEntry()]);
    expect(file.filename).toMatch(/\.ndjson$/);
    expect(file.mimeType).toBe('application/x-ndjson');
    expect(() => JSON.parse(file.contents)).not.toThrow();
  });

  it('builds a .sh batch with shebang + set -euo pipefail', () => {
    const file = buildExportFile('curl', [makeEntry()]);
    expect(file.filename).toMatch(/\.sh$/);
    expect(file.mimeType).toBe('text/x-shellscript');
    expect(file.contents.startsWith('#!/usr/bin/env bash\nset -euo pipefail')).toBe(true);
    expect(file.contents).toContain('curl -X GET');
  });

  it('encodes the timestamp in the filename so concurrent exports differ', () => {
    const file = buildExportFile('har', [makeEntry()]);
    // ISO timestamp with `:` and `.` replaced by `-`.
    expect(file.filename).toMatch(
      /^restura-console-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.har$/
    );
  });
});
