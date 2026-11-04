// SSRF guard regressions: special-use address ranges and non-special-scheme
// host encodings that used to slip past `validateURL` (worker/self-host and the
// renderer's pre-flight check both rely on it; Electron fails closed later on
// DNS, but the string check must not be the weak link).
import { assertResolvedAddressAllowed, validateURL } from '@shared/protocol/url-validation';
import { describe, expect, it } from 'vitest';

describe('validateURL refuses special-use ranges by default', () => {
  it.each([
    'http://198.18.0.1/', // benchmarking / fake-IP pool
    'http://192.0.0.170/', // IETF protocol assignments
    'http://224.0.0.251/', // multicast (mDNS)
    'http://255.255.255.255/', // limited broadcast
    'http://240.0.0.1/', // reserved
    'http://100.100.100.200/', // CGNAT (Alibaba metadata lives here)
    'http://[64:ff9b:1::a00:1]/', // local-use NAT64
    'http://[::ffff:0:7f00:1]/', // SIIT-wrapped loopback
    'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', // Teredo
    'http://[ff02::1]/', // IPv6 multicast
  ])('%s', (url) => {
    expect(validateURL(url).valid).toBe(false);
  });
});

describe('non-special scheme host encodings are normalised', () => {
  const opts = { allowedSchemes: ['kafka:', 'mqtt:'] };
  it.each([
    'kafka://%31%32%37.0.0.1:9092',
    'kafka://127。0。0。1:9092',
    'mqtt://１２７.0.0.1:1883',
    'mqtt://%6c%6f%63%61%6c%68%6f%73%74:1883',
  ])('%s is refused', (url) => {
    expect(validateURL(url, opts).valid).toBe(false);
  });
});

describe('resolved-address guard covers the same ranges', () => {
  it.each(['198.18.0.1', '192.0.0.170', '255.255.255.255', 'ff02::1', '64:ff9b:1::a00:1'])(
    'refuses a hostname resolving to %s',
    (address) => {
      expect(() => assertResolvedAddressAllowed('fake-ip.example', address)).toThrow(/private/);
    }
  );

  it('refuses a Teredo address hiding the metadata IP even with the private carve-out', () => {
    expect(() =>
      assertResolvedAddressAllowed('x.example', '2001:0:4136:e378:8000:63bf:5601:5601', {
        allowPrivateLiteralHost: true,
      })
    ).toThrow(/metadata/);
  });
});
