import { describe, it, expect } from 'vitest';
import { capturedRequestToCase, type CapturedRequest } from '../datasetFromHistory';
import type { HttpRequest, Response as HttpResponse } from '@/types/http';

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
