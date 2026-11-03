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

const UPSTREAM_COOKIE = 'sid=UPSTREAM-SESSION-789; Path=/; HttpOnly';
const UPSTREAM_AUTH = 'Bearer UPSTREAM-ECHOED-TOKEN';

function resultWithResponse(): RunResult {
  const base = result();
  const [first] = base.requests;
  if (!first) throw new Error('fixture has one request');
  return {
    ...base,
    requests: [
      {
        ...first,
        setCookies: [UPSTREAM_COOKIE, 'theme=dark'],
        responseHeaders: {
          'Set-Cookie': UPSTREAM_COOKIE,
          'set-cookie2': UPSTREAM_COOKIE,
          Authorization: UPSTREAM_AUTH,
          'proxy-authorization': UPSTREAM_AUTH,
          'content-type': 'application/json',
        },
        streamEvents: [{ event: 'tick', data: 'payload-1', timestamp: 1 }],
      },
    ],
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

  it('response cookies and credential headers are redacted; other headers and stream events are kept', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'restura-redact-')), 'r.json');
    await new JsonReporter(out).onEnd(resultWithResponse());
    const text = readFileSync(out, 'utf-8');
    const html = renderHtml(resultWithResponse());
    for (const artifact of [text, html]) {
      expect(artifact).not.toContain('UPSTREAM-SESSION-789');
      expect(artifact).not.toContain('UPSTREAM-ECHOED-TOKEN');
    }
    const reported = JSON.parse(text).requests[0];
    expect(reported.setCookies).toEqual(['sid=[redacted]', 'theme=[redacted]']);
    expect(reported.responseHeaders).toEqual({
      'Set-Cookie': '[redacted]',
      'set-cookie2': '[redacted]',
      Authorization: '[redacted]',
      'proxy-authorization': '[redacted]',
      'content-type': 'application/json',
    });
    expect(reported.streamEvents).toEqual([{ event: 'tick', data: 'payload-1', timestamp: 1 }]);
  });
});
