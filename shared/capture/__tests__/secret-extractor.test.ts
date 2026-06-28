import { describe, expect, it } from 'vitest';
import { redactExchange } from '../secret-extractor';
import type { CapturedExchange } from '../types';

function baseExchange(): CapturedExchange {
  return {
    id: '1',
    protocol: 'rest',
    method: 'GET',
    url: 'https://api.example.com/me',
    startedAt: 0,
    request: {
      headers: [
        { name: 'Accept', value: 'application/json' },
        { name: 'Authorization', value: 'Bearer abcdef123456token' },
        { name: 'Cookie', value: 'session=topsecretvalue123' },
      ],
    },
    response: {
      status: 200,
      headers: [],
      body: {
        text: 'token eyJhbGciOiAns.eyJzdWIiOiAns.signaturepartxyz',
        mimeType: 'text/plain',
      },
    },
  };
}

describe('redactExchange', () => {
  it('replaces denied request headers with placeholders and records secrets', () => {
    const { exchange, secrets } = redactExchange(baseExchange());
    const auth = exchange.request.headers.find((h) => h.name === 'Authorization');
    expect(auth?.value).toMatch(/^\{\{.+\}\}$/);
    expect(auth?.value).not.toContain('abcdef123456token');
    const cookie = exchange.request.headers.find((h) => h.name === 'Cookie');
    expect(cookie?.value).toMatch(/^\{\{.+\}\}$/);
    expect(secrets.length).toBeGreaterThanOrEqual(2);
  });

  it('masks token patterns in response bodies', () => {
    const { exchange } = redactExchange(baseExchange());
    expect(exchange.response?.body?.text).not.toContain('eyJhbGciOiAns');
  });

  it('leaves non-secret headers untouched', () => {
    const { exchange } = redactExchange(baseExchange());
    const accept = exchange.request.headers.find((h) => h.name === 'Accept');
    expect(accept?.value).toBe('application/json');
  });

  it('does not mutate the input exchange', () => {
    const input = baseExchange();
    redactExchange(input);
    const auth = input.request.headers.find((h) => h.name === 'Authorization');
    expect(auth?.value).toBe('Bearer abcdef123456token');
  });
});
