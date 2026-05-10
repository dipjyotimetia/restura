import { describe, expect, it } from 'vitest';
import {
  buildOAuth1Header,
  hmacSha1Base64,
  hmacSha256Base64,
} from '../oauth1Signer';

describe('hmacSha1Base64 / hmacSha256Base64', () => {
  // Test vectors from RFC 2202 §3 and RFC 4231 — let us verify the pure-JS
  // HMAC implementation independently of OAuth before trusting it for signing.
  it('matches RFC 2202 HMAC-SHA1 test vector 1', () => {
    // key = 0x0b * 20, data = "Hi There" → digest hex
    // b617318655057264e28bc0b6fb378c8ef146be00 (verified against Node's
    // crypto.createHmac('sha1', ...) — base64 of those bytes follows.)
    const key = '\x0b'.repeat(20);
    expect(hmacSha1Base64('Hi There', key)).toBe('thcxhlUFcmTii8C2+zeMjvFGvgA=');
  });

  it('matches RFC 4231 HMAC-SHA256 test vector 1', () => {
    const key = '\x0b'.repeat(20);
    // Expected hex: b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7
    expect(hmacSha256Base64('Hi There', key)).toBe(
      'sDRMYdjbOFNcqK/OrwvxK4gdwgDJgz2nJuk3bC4yz/c=',
    );
  });
});

describe('buildOAuth1Header', () => {
  const baseConfig = {
    consumerKey: '9djdj82h48djs9d2',
    consumerSecret: 'j49sk3j29djd',
    accessToken: 'kkk9d7dh3k39sjv7',
    accessTokenSecret: 'dh893hdasih9',
  };

  it('throws when consumerKey is missing', () => {
    expect(() =>
      buildOAuth1Header('GET', 'https://example.com/', {
        consumerKey: '',
        consumerSecret: 'x',
      }),
    ).toThrow(/consumerKey/);
  });

  it('produces a header containing the OAuth 1.0a parameters', () => {
    const header = buildOAuth1Header('GET', 'https://example.com/api', baseConfig);
    expect(header).toMatch(/^OAuth /);
    expect(header).toContain('oauth_consumer_key="9djdj82h48djs9d2"');
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(header).toContain('oauth_token="kkk9d7dh3k39sjv7"');
    expect(header).toMatch(/oauth_timestamp="\d+"/);
    expect(header).toMatch(/oauth_nonce="[^"]+"/);
    expect(header).toMatch(/oauth_signature="[^"]+"/);
    expect(header).toContain('oauth_version="1.0"');
  });

  it('includes realm when provided', () => {
    const header = buildOAuth1Header('GET', 'https://example.com/api', {
      ...baseConfig,
      realm: 'photos',
    });
    expect(header).toContain('realm="photos"');
  });

  it('omits oauth_token when no access token configured', () => {
    const header = buildOAuth1Header('GET', 'https://example.com/api', {
      consumerKey: 'k',
      consumerSecret: 's',
    });
    expect(header).not.toContain('oauth_token=');
  });

  it('honours fixed nonce + timestamp for deterministic signing', () => {
    const header1 = buildOAuth1Header('GET', 'https://example.com/api', {
      ...baseConfig,
      nonce: 'fixednonce123',
      timestamp: '1700000000',
    });
    const header2 = buildOAuth1Header('GET', 'https://example.com/api', {
      ...baseConfig,
      nonce: 'fixednonce123',
      timestamp: '1700000000',
    });
    // Same inputs → identical header (covers signature too).
    expect(header1).toBe(header2);
    expect(header1).toContain('oauth_nonce="fixednonce123"');
    expect(header1).toContain('oauth_timestamp="1700000000"');
  });

  it('produces a valid HMAC-SHA1 signature for fixed inputs', () => {
    // Self-consistent vector: pin nonce + timestamp + URL + creds, then verify
    // the signature is well-formed (44 chars, base64 trailing '=' padding for
    // a 20-byte SHA-1 digest is 'XXXXXXXXXXXXXXXXXXXXXXXXXXXX=' → 28 chars
    // before percent-encoding; oauth-1.0a percent-encodes the value).
    const header = buildOAuth1Header(
      'POST',
      'https://api.example.com/v1/resource',
      {
        ...baseConfig,
        nonce: '7d8f3e2a1b4c',
        timestamp: '1318622958',
      },
    );
    const sigMatch = /oauth_signature="([^"]+)"/.exec(header);
    expect(sigMatch).not.toBeNull();
    // Signature is a base64-encoded 20-byte digest — 28 chars (one '=' pad)
    // and oauth-1.0a percent-encodes '+', '/', '=' to '%2B', '%2F', '%3D'.
    // After decoding we expect a string with the right shape.
    const sig = decodeURIComponent(sigMatch![1]!);
    expect(sig).toMatch(/^[A-Za-z0-9+/]{27}=$/);
  });

  it('uses HMAC-SHA256 when configured', () => {
    const header = buildOAuth1Header('GET', 'https://example.com/api', {
      ...baseConfig,
      signatureMethod: 'HMAC-SHA256',
      nonce: 'abc',
      timestamp: '1700000000',
    });
    expect(header).toContain('oauth_signature_method="HMAC-SHA256"');
    const sigMatch = /oauth_signature="([^"]+)"/.exec(header);
    expect(sigMatch).not.toBeNull();
    const sig = decodeURIComponent(sigMatch![1]!);
    // SHA-256 → 32 bytes → 44 base64 chars (one '=' pad).
    expect(sig).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it('PLAINTEXT signature equals percent-encoded signing key', () => {
    const header = buildOAuth1Header('GET', 'https://example.com/api', {
      consumerKey: 'ck',
      consumerSecret: 'cs',
      accessToken: 'tk',
      accessTokenSecret: 'ts',
      signatureMethod: 'PLAINTEXT',
      nonce: 'n',
      timestamp: '1',
    });
    expect(header).toContain('oauth_signature_method="PLAINTEXT"');
    // Signing key is "cs&ts" — toHeader percent-encodes '&' to %26.
    const sigMatch = /oauth_signature="([^"]+)"/.exec(header);
    expect(sigMatch).not.toBeNull();
    expect(decodeURIComponent(sigMatch![1]!)).toBe('cs&ts');
  });

  it('different nonces produce different signatures', () => {
    const a = buildOAuth1Header('GET', 'https://example.com/api', {
      ...baseConfig,
      nonce: 'a',
      timestamp: '1700000000',
    });
    const b = buildOAuth1Header('GET', 'https://example.com/api', {
      ...baseConfig,
      nonce: 'b',
      timestamp: '1700000000',
    });
    const sigA = /oauth_signature="([^"]+)"/.exec(a)?.[1];
    const sigB = /oauth_signature="([^"]+)"/.exec(b)?.[1];
    expect(sigA).not.toBe(sigB);
  });

  it('addParamsToBody folds form params into the signature base string', () => {
    const without = buildOAuth1Header(
      'POST',
      'https://api.example.com/post',
      { ...baseConfig, nonce: 'n', timestamp: '1' },
      { foo: 'bar' },
    );
    const withFlag = buildOAuth1Header(
      'POST',
      'https://api.example.com/post',
      { ...baseConfig, nonce: 'n', timestamp: '1', addParamsToBody: true },
      { foo: 'bar' },
    );
    const sigWithout = /oauth_signature="([^"]+)"/.exec(without)?.[1];
    const sigWith = /oauth_signature="([^"]+)"/.exec(withFlag)?.[1];
    expect(sigWith).not.toBe(sigWithout);
  });
});
