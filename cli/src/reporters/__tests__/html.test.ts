import { describe, it, expect } from 'vitest';
import { renderHtml } from '../html';
import type { RunResult, RequestRunResult } from '../types';
import type { LoadedRequest } from '../../runner/collectionLoader';

const fakeReq = (name: string): LoadedRequest => ({
  filePath: '/x/y.http.yaml',
  relativePath: 'y.http.yaml',
  folderPath: [],
  type: 'http',
  request: {
    id: '1',
    name,
    type: 'http',
    method: 'GET',
    url: '/',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  } as never,
});

describe('renderHtml', () => {
  it('renders a self-contained HTML page with rows and summary', () => {
    const result: RunResult = {
      meta: { collectionName: 'My Collection', collectionDir: '/x', startedAt: 1 },
      durationMs: 1234,
      requests: [
        {
          request: fakeReq('Get user'),
          status: 200,
          passed: true,
          durationMs: 50,
          bodyBytes: 100,
        } as RequestRunResult,
        {
          request: fakeReq('Bad'),
          status: 500,
          passed: false,
          durationMs: 80,
          bodyBytes: 0,
        } as RequestRunResult,
      ],
      summary: { total: 2, passed: 1, failed: 1, errored: 0 },
    };
    const html = renderHtml(result);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('My Collection');
    expect(html).toContain('Get user');
    expect(html).toContain('Bad');
    expect(html).toContain('1 passed');
    expect(html).toContain('1 failed');
    expect(html).toContain('<script type="application/json" id="results">');
  });

  it('escapes HTML in collection name and request names', () => {
    const result: RunResult = {
      meta: {
        collectionName: '<script>alert(1)</script>',
        collectionDir: '/x',
        startedAt: 1,
      },
      durationMs: 0,
      requests: [],
      summary: { total: 0, passed: 0, failed: 0, errored: 0 },
    };
    const html = renderHtml(result);
    // The literal raw <script>alert(1)</script> must NOT appear in the body content.
    // (The trailing `<script type="application/json">` block embeds JSON-escaped text,
    // so we check for the dangerous unescaped form specifically.)
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes JSON-island breakout attempts (`</script>` inside names)', () => {
    const result: RunResult = {
      meta: { collectionName: 'C', collectionDir: '/x', startedAt: 1 },
      durationMs: 0,
      requests: [
        {
          request: fakeReq('</script><script>alert(1)</script>'),
          status: 200,
          passed: true,
          durationMs: 0,
          bodyBytes: 0,
        } as RequestRunResult,
      ],
      summary: { total: 1, passed: 1, failed: 0, errored: 0 },
    };
    const html = renderHtml(result);
    // The raw `</script>` MUST NOT appear inside the JSON island, or the
    // browser would close the script tag early and execute the next one.
    const islandMatch = html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
    expect(islandMatch?.[1]).toBeDefined();
    expect(islandMatch![1]).not.toContain('</script>');
    // And the escaped form must round-trip through JSON.parse.
    const parsed = JSON.parse(islandMatch![1]!.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&'));
    expect(parsed.requests[0].request.request.name).toBe('</script><script>alert(1)</script>');
  });

  it('renders an error message inline for errored rows', () => {
    const result: RunResult = {
      meta: { collectionName: 'C', collectionDir: '/x', startedAt: 1 },
      durationMs: 100,
      requests: [
        {
          request: fakeReq('Net fail'),
          status: 0,
          passed: false,
          durationMs: 10,
          bodyBytes: 0,
          errorMessage: 'connect ECONNREFUSED',
        } as RequestRunResult,
      ],
      summary: { total: 1, passed: 0, failed: 0, errored: 1 },
    };
    const html = renderHtml(result);
    expect(html).toContain('connect ECONNREFUSED');
    expect(html).toContain('class="err-msg"');
    expect(html).toContain('ERROR');
  });
});
