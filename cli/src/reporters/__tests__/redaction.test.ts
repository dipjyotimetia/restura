import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpRequest } from '@shared/types';
import { describe, expect, it } from 'vitest';
import type { LoadedRequest } from '../../runner/collectionLoader';
import { renderHtml } from '../html';
import { JsonReporter } from '../json';
import type { RunResult } from '../types';

const TOKEN = 'tok-SUPER-SECRET-123';
const COOKIE = 'session=COOKIE-SECRET-456';

function result(): RunResult {
  const request: LoadedRequest = {
    relativePath: 'Users/Get',
    folderPath: ['Users'],
    type: 'http',
    request: {
      id: 'r1',
      name: 'Get',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/users',
      headers: [{ id: 'h', key: 'Cookie', value: COOKIE, enabled: true }],
      params: [],
      body: { type: 'none' },
      auth: { type: 'bearer', bearer: { token: TOKEN } },
    } as HttpRequest,
  };
  return {
    meta: { collectionName: 'C', collectionDir: '/c', startedAt: 1 },
    durationMs: 1,
    requests: [{ request, status: 200, passed: true, durationMs: 1, bodyBytes: 0 }],
    summary: { total: 1, passed: 1, failed: 0, errored: 0 },
  };
}

describe('report redaction', () => {
  it('the JSON report carries no inline auth secret or request cookie', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'restura-redact-')), 'r.json');
    await new JsonReporter(out).onEnd(result());
    const text = readFileSync(out, 'utf-8');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(COOKIE);
    const json = JSON.parse(text);
    expect(json.requests[0].request).toMatchObject({
      relativePath: 'Users/Get',
      folderPath: ['Users'],
      type: 'http',
      request: {
        name: 'Get',
        method: 'GET',
        url: 'https://api.example.com/users',
        auth: { type: 'bearer', bearer: { token: '[redacted]' } },
      },
    });
  });

  it('the HTML report carries no inline auth secret or request cookie', () => {
    const html = renderHtml(result());
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain(COOKIE);
    expect(html).toContain('Users/Get');
  });
});
