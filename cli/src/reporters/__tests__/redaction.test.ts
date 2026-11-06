import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpRequest } from '@shared/types';
import { describe, expect, it } from 'vitest';
import type { LoadedRequest } from '../../runner/collectionLoader';
import { renderHtml } from '../html';
import { JsonReporter } from '../json';
import { renderJUnitXml } from '../junit';
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

describe('report redaction — shared credential header list (B3)', () => {
  const API_KEY = 'APIKEY-SECRET-0042';
  function resultWithApiKey(): RunResult {
    const base = result();
    const [first] = base.requests;
    if (!first) throw new Error('fixture has one request');
    const request = {
      ...first.request,
      request: {
        ...first.request.request,
        headers: [{ id: 'k', key: 'x-api-key', value: API_KEY, enabled: true }],
      } as HttpRequest,
    };
    return {
      ...base,
      requests: [
        {
          ...first,
          request,
          passed: false,
          errorMessage: `upstream rejected Authorization: Bearer ${API_KEY}`,
          assertions: [{ name: 'ok', passed: false, error: `expected token=${API_KEY}` }],
          responseHeaders: {
            'X-Api-Key': API_KEY,
            'x-custom-secret': API_KEY,
            'x-auth-token': API_KEY,
            'content-type': 'application/json',
          },
        },
      ],
    };
  }

  it('x-api-key request and response headers and error text never reach JSON/HTML reports', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'restura-redact-')), 'r.json');
    await new JsonReporter(out).onEnd(resultWithApiKey());
    const text = readFileSync(out, 'utf-8');
    const html = renderHtml(resultWithApiKey());
    const junit = renderJUnitXml(resultWithApiKey());
    for (const artifact of [text, html, junit]) expect(artifact).not.toContain(API_KEY);
    const reported = JSON.parse(text).requests[0];
    expect(reported.responseHeaders).toEqual({
      'X-Api-Key': '[redacted]',
      'x-custom-secret': '[redacted]',
      'x-auth-token': '[redacted]',
      'content-type': 'application/json',
    });
  });
});
