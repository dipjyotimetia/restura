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

  it('redacts credential query-string parameters in the URL', () => {
    const ex = baseExchange();
    ex.url = 'https://api.example.com/me?access_token=topsecretquerytoken&page=1';
    const { exchange, secrets } = redactExchange(ex);
    expect(exchange.url).not.toContain('topsecretquerytoken');
    expect(exchange.url).toContain('page=1');
    expect(secrets.some((s) => s.name === 'accessToken')).toBe(true);
  });

  it('masks token patterns inside base64-encoded bodies', () => {
    const ex = baseExchange();
    const jwt = 'eyJhbGciOiAns.eyJzdWIiOiAns.signaturepartxyz';
    ex.response = {
      status: 200,
      headers: [],
      body: { base64: btoa(`{"jwt":"${jwt}"}`) },
    };
    const { exchange } = redactExchange(ex);
    const decoded = atob(exchange.response?.body?.base64 ?? '');
    expect(decoded).not.toContain('eyJhbGciOiAns');
  });

  it('masks tokens carried in non-denylisted header values (Location/Referer)', () => {
    const ex = baseExchange();
    ex.url = 'https://api.example.com/authorize';
    ex.request.headers.push({
      name: 'Referer',
      value: 'https://app.example.com/page?access_token=referertokenSECRET&theme=dark',
    });
    ex.response = {
      status: 302,
      headers: [
        {
          name: 'Location',
          value: 'https://app.example.com/cb?code=oauthCODEsecret123&state=xyz',
        },
      ],
    };
    const { exchange } = redactExchange(ex);
    const referer = exchange.request.headers.find((h) => h.name === 'Referer');
    expect(referer?.value).not.toContain('referertokenSECRET');
    expect(referer?.value).toContain('theme=dark');
    const location = exchange.response?.headers.find((h) => h.name === 'Location');
    expect(location?.value).not.toContain('oauthCODEsecret123');
    expect(location?.value).toContain('state=xyz');
  });

  it('masks a bare Bearer/JWT embedded in an arbitrary header value', () => {
    const ex = baseExchange();
    ex.request.headers.push({
      name: 'X-Forwarded-Auth',
      value: 'Bearer eyJhbGciOiAns.eyJzdWIiOiAns.sigbearerheaderxyz',
    });
    const { exchange } = redactExchange(ex);
    const h = exchange.request.headers.find((x) => x.name === 'X-Forwarded-Auth');
    expect(h?.value).not.toContain('eyJhbGciOiAns');
  });
});
