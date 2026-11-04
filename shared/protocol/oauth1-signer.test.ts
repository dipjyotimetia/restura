import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { executeHttpProxy } from './http-proxy';
import { buildOAuth1BaseString, buildOAuth1Header, oauth1PercentEncode } from './oauth1-signer';
import type { Fetcher } from './types';

// RFC 5849 §3.4.1.1 example request:
//   POST /request?b5=%3D%253D&a3=a&c%40=&a2=r%20b
//   Host: example.com, body `c2&a3=2+q` (application/x-www-form-urlencoded)
const RFC_BASE_STRING =
  'POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7';

describe('OAuth1 signature base string (RFC 5849 §3.4.1)', () => {
  it('matches the RFC 5849 §3.4.1.1 example, keeping the duplicate a3 and decoding c%40', () => {
    const base = buildOAuth1BaseString(
      'POST',
      'http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b',
      [
        ['oauth_consumer_key', '9djdj82h48djs9d2'],
        ['oauth_token', 'kkk9d7dh3k39sjv7'],
        ['oauth_signature_method', 'HMAC-SHA1'],
        ['oauth_timestamp', '137131201'],
        ['oauth_nonce', '7d8f3e4a'],
        // decoded form body `c2&a3=2+q`
        ['c2', ''],
        ['a3', '2 q'],
      ]
    );
    expect(base).toBe(RFC_BASE_STRING);
  });

  it('signs that base string with HMAC-SHA1 over the encoded secrets', () => {
    const header = buildOAuth1Header(
      'POST',
      'http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b',
      {
        consumerKey: '9djdj82h48djs9d2',
        consumerSecret: 'j49sj83j',
        accessToken: 'kkk9d7dh3k39sjv7',
        accessTokenSecret: 'dh893hdasih9',
        signatureMethod: 'HMAC-SHA1',
        nonce: '7d8f3e4a',
        timestamp: '137131201',
        realm: 'Example',
        addParamsToBody: true,
      },
      { c2: '', a3: '2 q' }
    );
    // Base string without the RFC's oauth_version (the header always carries 1.0).
    const withVersion = RFC_BASE_STRING.replace(
      'oauth_token%3Dkkk9d7dh3k39sjv7',
      'oauth_token%3Dkkk9d7dh3k39sjv7%26oauth_version%3D1.0'
    );
    const expected = createHmac('sha1', 'j49sj83j&dh893hdasih9')
      .update(withVersion)
      .digest('base64');
    expect(header).toContain(`oauth_signature="${oauth1PercentEncode(expected)}"`);
    expect(header.startsWith('OAuth realm="Example", ')).toBe(true);
  });

  it('normalizes the base URI: lowercase scheme/host, default port dropped', () => {
    const base = buildOAuth1BaseString('get', 'HTTP://Example.COM:80/r%20v/X', []);
    expect(base).toBe('GET&http%3A%2F%2Fexample.com%2Fr%2520v%2FX&');
  });
});

describe('OAuth1 through the proxy (sign = send)', () => {
  it('signs a query value with a space exactly as it goes on the wire (%20)', async () => {
    const fetcher = vi.fn<Fetcher>(async () => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      text: async () => '',
      contentLengthHeader: '0',
    }));
    await executeHttpProxy(
      {
        method: 'GET',
        url: 'https://api.example.com/search?q=hello world',
        auth: {
          type: 'oauth1',
          oauth1: {
            consumerKey: 'ck',
            consumerSecret: 'cs',
            signatureMethod: 'HMAC-SHA1',
            nonce: 'n',
            timestamp: '1',
          },
        },
      },
      fetcher,
      { allowLocalhost: false }
    );
    const sent = fetcher.mock.calls[0]?.[0];
    expect(sent?.url).toBe('https://api.example.com/search?q=hello%20world');
    const auth = new Headers(sent?.headers as HeadersInit).get('authorization') ?? '';
    const sig = decodeURIComponent(/oauth_signature="([^"]+)"/.exec(auth)?.[1] ?? '');
    const base =
      'GET&https%3A%2F%2Fapi.example.com%2Fsearch&' +
      oauth1PercentEncode(
        'oauth_consumer_key=ck&oauth_nonce=n&oauth_signature_method=HMAC-SHA1&oauth_timestamp=1&oauth_version=1.0&q=hello%20world'
      );
    expect(sig).toBe(createHmac('sha1', 'cs&').update(base).digest('base64'));
  });
});
