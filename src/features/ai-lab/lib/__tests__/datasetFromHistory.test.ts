import { describe, expect, it } from 'vitest';
import type { HttpRequest, Response as HttpResponse } from '@/types/http';
import {
  type CapturedRequest,
  capturedRequestsToCases,
  capturedRequestToCase,
  previewRedactions,
  secretValuesFromScopes,
} from '../datasetFromHistory';

function req(over: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id: 'r1',
    name: 'test',
    type: 'http',
    method: 'POST',
    url: 'https://api.test/login',
    headers: [
      { id: 'h1', key: 'Content-Type', value: 'application/json', enabled: true },
      {
        id: 'h2',
        key: 'Authorization',
        value: 'Bearer sk-secret-token-abc123456789',
        enabled: true,
      },
    ],
    params: [],
    body: { type: 'json', raw: '{"user":"a"}' },
    auth: { type: 'none' },
    ...over,
  };
}

describe('capturedRequestToCase', () => {
  it('maps request fields to vars', () => {
    const c = capturedRequestToCase({ request: req() });
    expect(c.vars.method).toBe('POST');
    expect(c.vars.url).toBe('https://api.test/login');
    expect(c.vars.body).toBe('{"user":"a"}');
  });

  it('redacts credential headers', () => {
    const c = capturedRequestToCase({ request: req() });
    const headers = JSON.parse(c.vars.headers ?? '{}') as Record<string, string>;
    expect(headers.Authorization).toBe('[REDACTED]');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('redacts secrets in the response body reference', () => {
    const response: HttpResponse = {
      id: 'resp1',
      requestId: 'r1',
      status: 200,
      statusText: 'OK',
      headers: {},
      body: 'token=sk-secret-token-abcdef0123456789 issued',
      size: 10,
      time: 12,
      timestamp: 0,
    };
    const c = capturedRequestToCase({ request: req(), response });
    expect(c.reference).toContain('[REDACTED]');
    expect(c.reference).not.toContain('sk-secret-token-abcdef0123456789');
  });

  it('omits reference when there is no captured response', () => {
    const c = capturedRequestToCase({ request: req() } as CapturedRequest);
    expect(c.reference).toBeUndefined();
  });
});

describe('capturedRequestToCase environment/secret stripping (#1029)', () => {
  const SECRET = 'opaque-tenant-key-77f3a91c';
  const secretValues = [SECRET];

  it('strips env values from the url path, query, headers and body', () => {
    const c = capturedRequestToCase(
      {
        request: req({
          url: `https://api.test/${SECRET}/users?tenant=${SECRET}&page=2`,
          headers: [{ id: 'h', key: 'X-Tenant', value: SECRET, enabled: true }],
          body: { type: 'json', raw: `{"owner":"${SECRET}"}` },
        }),
        response: {
          id: 'r',
          requestId: 'r1',
          status: 200,
          statusText: 'OK',
          headers: {},
          body: `echo ${SECRET}`,
          size: 1,
          time: 1,
          timestamp: 0,
        },
      },
      { secretValues }
    );
    expect(JSON.stringify(c)).not.toContain(SECRET);
  });

  it('scrubs userinfo, fragments, query values and opaque path segments without env help', () => {
    const c = capturedRequestToCase({
      request: req({
        url: 'https://user:hunter2@api.test/v1/Zx9Qk2Lm8Pw4Vb7Nc1Rt5Yh3Jd6/items?id=42&sig=abcDEF123#frag',
      }),
    });
    expect(c.vars.url).toBe('https://api.test/v1/[REDACTED]/items?id=[REDACTED]&sig=[REDACTED]');
  });

  it('keeps templated {{vars}} readable', () => {
    const c = capturedRequestToCase({
      request: req({ url: '{{baseUrl}}/users?token={{token}}&q=a' }),
    });
    expect(c.vars.url).toBe('{{baseUrl}}/users?token={{token}}&q=[REDACTED]');
  });

  it('pattern-redacts header values, not just denylisted header names', () => {
    const c = capturedRequestToCase({
      request: req({
        headers: [
          { id: 'h', key: 'X-Relay', value: 'Bearer abcdef1234567890', enabled: true },
          { id: 'g', key: 'X-Note', value: 'hello', enabled: true },
        ],
      }),
    });
    const headers = JSON.parse(c.vars.headers ?? '{}') as Record<string, string>;
    expect(headers['X-Relay']).not.toContain('abcdef1234567890');
    expect(headers['X-Note']).toBe('hello');
  });

  it('strips encoded forms of known values (url-encoded, base64, JSON-escaped)', () => {
    const value = 'p@ss "w0rd"/ü+9z';
    const encoded = encodeURIComponent(value);
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(value)));
    const jsonEscaped = JSON.stringify(value).slice(1, -1);
    const c = capturedRequestToCase(
      {
        request: req({
          url: `https://api.test/x?q=${encoded}`,
          headers: [{ id: 'h', key: 'X-B', value: b64, enabled: true }],
          body: { type: 'json', raw: `{"pw":"${jsonEscaped}"}` },
        }),
      },
      { secretValues: [value] }
    );
    const out = JSON.stringify(c);
    for (const form of [value, encoded, b64, jsonEscaped]) expect(out).not.toContain(form);
  });

  it('handles an @ inside the password and bare query tokens', () => {
    const c = capturedRequestToCase({
      request: req({ url: 'https://user:p@ssw0rd@api.test/v1?abcDEF123456&flag=1' }),
    });
    expect(c.vars.url).not.toContain('ssw0rd');
    expect(c.vars.url).not.toContain('abcDEF123456');
    expect(c.vars.url?.startsWith('https://api.test/v1?')).toBe(true);
  });

  it('skips disabled and unnamed headers and tolerates missing or non-text bodies', () => {
    const none = capturedRequestToCase({
      request: req({
        headers: [
          { id: 'a', key: 'X-Off', value: 'hidden', enabled: false },
          { id: 'b', key: '', value: 'nameless', enabled: true },
        ],
        body: { type: 'none' },
      }),
    });
    expect(none.vars.headers).toBe('{}');
    expect(none.vars.body).toBe('');
    const binary = capturedRequestToCase({
      request: req({ body: { type: 'binary' } as HttpRequest['body'] }),
    });
    expect(binary.vars.body).toBe('');
    expect(
      capturedRequestToCase({ request: { ...req(), body: undefined } as unknown as HttpRequest })
        .vars.body
    ).toBe('');
  });

  it('scrubs a host-only URL, empty query pairs and bare templated query tokens', () => {
    const c = capturedRequestToCase({
      request: req({ url: 'https://api.test?a=1&&{{tok}}&flag#x' }),
    });
    expect(c.vars.url).toBe('https://api.test?a=[REDACTED]&&{{tok}}&[REDACTED]');
  });

  it('handles a response without a body and the default options', () => {
    const response = {
      id: 'r',
      requestId: 'r1',
      status: 204,
      statusText: 'No Content',
      headers: {},
      size: 0,
      time: 1,
      timestamp: 0,
    } as unknown as HttpResponse;
    expect(capturedRequestToCase({ request: req(), response }).reference).toBe('');
    const [only] = capturedRequestsToCases([{ request: req() }]);
    expect(only?.vars.method).toBe('POST');
    expect(previewRedactions({ request: req(), response }).map((d) => d.field)).toEqual([
      'headers',
    ]);
  });

  it('collects scoped variable values, including disabled ones', () => {
    const environment = [
      { key: 'a', value: 'enabled-secret-1', enabled: true },
      { key: 'b', value: 'disabled-secret-2', enabled: false },
      { key: 'c', value: '' },
    ];
    expect(
      secretValuesFromScopes([environment, undefined, [{ value: 'folder-secret-3' }]])
    ).toEqual(['enabled-secret-1', 'disabled-secret-2', 'folder-secret-3']);
  });

  it('previewRedactions lists only changed fields with before and after', () => {
    const diff = previewRedactions(
      {
        request: req({
          url: `https://api.test/x?k=${SECRET}`,
          body: { type: 'json', raw: `{"a":"${SECRET}"}` },
        }),
      },
      { secretValues }
    );
    expect(diff.map((d) => d.field)).toEqual(['url', 'headers', 'body']);
    expect(diff[0]?.before).toContain(SECRET);
    expect(diff[0]?.after).not.toContain(SECRET);
  });
});
