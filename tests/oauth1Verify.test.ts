import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  buildBaseString,
  parseOAuthHeader,
  rfc3986,
  verifyOAuth1,
} from '../e2e/mocks/oauth1Verify';

// Validates the mock's INDEPENDENT OAuth 1.0a verifier (used by the desktop
// auth e2e) before it is trusted to judge the client signer. Lives under
// tests/ so Vitest picks it up (e2e/ is Playwright-only).
describe('oauth1Verify — independent RFC 5849 verifier', () => {
  // Load-bearing: the signature base string for the RFC 5849 §3.4.1.1 worked
  // example must match the RFC byte-for-byte. This proves the tricky
  // normalization (percent-encoding, dup keys, query+body params, sorting) is
  // correct WITHOUT borrowing the client signer's logic.
  it('reproduces the RFC 5849 §3.4.1.1 signature base string', () => {
    const oauthParams = {
      realm: 'Example',
      oauth_consumer_key: '9djdj82h48djs9d2',
      oauth_token: 'kkk9d7dh3k39sjv7',
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: '137131201',
      oauth_nonce: '7d8f3e4a',
    };
    const base = buildBaseString(
      'POST',
      'http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b',
      oauthParams,
      { c2: '', a3: '2 q' }
    );
    expect(base).toBe(
      'POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3' +
        '%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_key%3D9dj' +
        'dj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_method%3DHMAC-' +
        'SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7'
    );
  });

  it('encodes per RFC 3986 (unreserved chars survive; others escape)', () => {
    expect(rfc3986('AZaz09-._~')).toBe('AZaz09-._~');
    expect(rfc3986("a b!*'()")).toBe('a%20b%21%2A%27%28%29');
  });

  it('parses an OAuth Authorization header into decoded params', () => {
    const p = parseOAuthHeader(
      'OAuth oauth_consumer_key="ck", oauth_nonce="n1", oauth_signature="aGVsbG8%3D"'
    );
    expect(p.oauth_consumer_key).toBe('ck');
    expect(p.oauth_signature).toBe('aGVsbG8='); // %3D decoded
  });

  // Glue check: a header whose signature we compute the same way verifies; a
  // wrong secret is rejected (fail-closed, constant-time compare).
  it('accepts a correctly-signed request and rejects a wrong secret', () => {
    const method = 'GET';
    const url = 'http://localhost:8080/oauth1/protected?foo=bar';
    const params: Record<string, string> = {
      oauth_consumer_key: 'ck',
      oauth_token: 'tok',
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: '1700000000',
      oauth_nonce: 'abc123',
      oauth_version: '1.0',
    };
    const signingKey = `${rfc3986('csecret')}&${rfc3986('tsecret')}`;
    const sig = createHmac('sha1', signingKey)
      .update(buildBaseString(method, url, params))
      .digest('base64');
    const header =
      'OAuth ' +
      Object.entries({ ...params, oauth_signature: sig })
        .map(([k, v]) => `${k}="${rfc3986(v)}"`)
        .join(', ');

    expect(
      verifyOAuth1(method, url, header, { consumerSecret: 'csecret', tokenSecret: 'tsecret' }).valid
    ).toBe(true);
    expect(
      verifyOAuth1(method, url, header, { consumerSecret: 'WRONG', tokenSecret: 'tsecret' }).valid
    ).toBe(false);
  });
});
