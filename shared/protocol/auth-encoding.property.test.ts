import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalSigV4HeaderValue, canonicalSigV4Uri } from './auth-signer';
import { buildRequestBody } from './body-builder';
import { buildOAuth1BaseString, oauth1PercentEncode } from './oauth1-signer';

const runs = { numRuns: 80 };
const text = fc.string({ maxLength: 40, unit: 'grapheme' });

describe('auth and body encoding properties', () => {
  it('oauth1 percent-encoding round-trips through decodeURIComponent', () => {
    fc.assert(
      fc.property(text, (value) => {
        expect(decodeURIComponent(oauth1PercentEncode(value))).toBe(value);
      }),
      runs
    );
  });

  it('OAuth1 base strings ignore parameter order, method case, and default ports', () => {
    const pair = fc.tuple(
      text.filter((name) => name !== 'oauth_signature' && name !== 'realm' && !name.includes('&')),
      text
    );
    fc.assert(
      fc.property(
        fc.array(pair, { maxLength: 6 }),
        fc.constantFrom('GET', 'POST', 'PUT'),
        (params, method) => {
          const forward = buildOAuth1BaseString(
            method,
            'https://Example.TEST:443/a/b?z=1&a=2',
            params
          );
          const reversed = buildOAuth1BaseString(
            method.toLowerCase(),
            'https://example.test/a/b?a=2&z=1',
            [...params].reverse()
          );
          expect(reversed).toBe(forward);
        }
      ),
      runs
    );
  });

  it('SigV4 header canonicalisation is idempotent, and a plain path stays plain', () => {
    const segment = fc.stringMatching(/^[A-Za-z0-9]{1,8}$/);
    fc.assert(
      fc.property(
        text,
        fc.array(segment, { minLength: 1, maxLength: 4 }),
        fc.boolean(),
        (header, segments, trailingSlash) => {
          const once = canonicalSigV4HeaderValue(header);
          expect(canonicalSigV4HeaderValue(once)).toBe(once);
          const path = `/${segments.join('/')}${trailingSlash ? '/' : ''}`;
          expect(canonicalSigV4Uri(path, false)).toBe(path);
          const encoded = canonicalSigV4Uri(path, true);
          expect(canonicalSigV4Uri(encoded, true)).toBe(encoded);
          expect(encoded.includes('%2F')).toBe(false);
        }
      ),
      runs
    );
  });

  it('form-urlencoded bodies round-trip through URLSearchParams', () => {
    const field = fc.record({
      name: text,
      value: text,
    });
    fc.assert(
      fc.property(fc.array(field, { maxLength: 6 }), (fields) => {
        const built = buildRequestBody({ bodyType: 'form-urlencoded', formData: fields });
        expect(built.contentType).toBe('application/x-www-form-urlencoded');
        const parsed = [...new URLSearchParams(String(built.body ?? '')).entries()];
        expect(parsed).toEqual(fields.map((field) => [field.name, field.value]));
      }),
      runs
    );
  });
});
