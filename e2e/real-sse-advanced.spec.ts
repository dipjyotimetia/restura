import { test, expect } from './fixtures/servers';

/**
 * Realistic SSE scenarios: Last-Event-ID resume, retry directive, comments,
 * multi-line data values. These exercise the parser's handling of the full
 * SSE wire format rather than just default `data:` frames.
 */
test.describe('SSE — resume via Last-Event-ID', () => {
  test('first connect emits ids 1..3', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/stream/sse-resume`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('retry: 50');
    expect(text).toMatch(/id:\s*1[\s\S]*?"n":1/);
    expect(text).toMatch(/id:\s*3[\s\S]*?"n":3/);
  });

  test('resume with Last-Event-ID: 5 starts emitting from id 6', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/stream/sse-resume`, {
      headers: { 'last-event-id': '5' },
    });
    const text = await res.text();
    expect(text).toMatch(/id:\s*6[\s\S]*?"n":6/);
    expect(text).toMatch(/id:\s*8[\s\S]*?"n":8/);
    expect(text).not.toMatch(/id:\s*5\b/);
  });
});

test.describe('SSE — comments + retry + multi-line data', () => {
  test('comment, retry directive, and multi-line data are emitted as wire-formatted', async ({
    servers,
  }) => {
    const res = await fetch(`${servers.http.url}/stream/sse-comments`);
    const text = await res.text();
    expect(text).toContain(': heartbeat');
    expect(text).toContain('retry: 5000');
    expect(text).toContain('data: line one');
    expect(text).toContain('data: line two');
    expect(text).toContain('data: line three');
    expect(text).toContain('id: 2');
  });
});
