import { describe, it, expect } from 'vitest';
import {
  validateURL,
  assertResolvedAddressAllowed,
  isPrivateAddress,
} from './url-validation';

describe('validateURL', () => {
  it('accepts a public https URL', () => {
    expect(validateURL('https://api.example.com/v1', {}).valid).toBe(true);
  });

  it('rejects ftp:// schemes', () => {
    const r = validateURL('ftp://example.com', {});
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/scheme/);
  });

  it('rejects 169.254.169.254 (cloud metadata) by default', () => {
    expect(validateURL('http://169.254.169.254/latest/meta-data', {}).valid).toBe(false);
  });

  it('rejects metadata.google.internal by default', () => {
    expect(validateURL('http://metadata.google.internal/', {}).valid).toBe(false);
  });

  it('rejects RFC1918 ranges by default', () => {
    expect(validateURL('http://10.0.0.1/', {}).valid).toBe(false);
    expect(validateURL('http://192.168.1.1/', {}).valid).toBe(false);
    expect(validateURL('http://172.20.0.1/', {}).valid).toBe(false);
  });

  it('allows localhost only when allowLocalhost: true', () => {
    expect(validateURL('http://localhost:8080', {}).valid).toBe(false);
    expect(validateURL('http://localhost:8080', { allowLocalhost: true }).valid).toBe(true);
  });

  it('allowLocalhost does NOT also unblock RFC1918', () => {
    expect(validateURL('http://10.0.0.1/', { allowLocalhost: true }).valid).toBe(false);
  });

  it('rejects URLs over 2048 chars', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(3000);
    expect(validateURL(longUrl, {}).valid).toBe(false);
  });

  it('warns on URLs containing credentials', () => {
    const r = validateURL('https://user:pass@example.com/', {});
    expect(r.valid).toBe(true);
    expect(r.warnings?.some((w) => /credentials/i.test(w))).toBe(true);
  });
});

describe('assertResolvedAddressAllowed', () => {
  it('throws if a public hostname resolves to a private IP (DNS rebind)', () => {
    expect(() =>
      assertResolvedAddressAllowed('attacker.example.com', '127.0.0.1', {})
    ).toThrow(/private/);
    expect(() =>
      assertResolvedAddressAllowed('attacker.example.com', '169.254.169.254', {})
    ).toThrow(/private/);
  });

  it('does not throw if hostname is allowed-private and address is private', () => {
    expect(() =>
      assertResolvedAddressAllowed('localhost', '127.0.0.1', { allowLocalhost: true })
    ).not.toThrow();
  });

  it('does not throw on a normal public address', () => {
    expect(() =>
      assertResolvedAddressAllowed('api.example.com', '93.184.216.34', {})
    ).not.toThrow();
  });

  it('proxy host that is a literal private IP can resolve to itself when allowPrivateLiteralHost is true', () => {
    expect(() =>
      assertResolvedAddressAllowed('192.168.1.1', '192.168.1.1', { allowPrivateLiteralHost: true })
    ).not.toThrow();
    expect(() =>
      assertResolvedAddressAllowed('10.0.0.5', '10.0.0.5', { allowPrivateLiteralHost: true })
    ).not.toThrow();
  });

  it('without allowPrivateLiteralHost, literal-IP hostname still rejected', () => {
    expect(() =>
      assertResolvedAddressAllowed('192.168.1.1', '192.168.1.1', {})
    ).toThrow(/private/);
  });

  it('handles upper-case IPv6 resolved addresses (DNS may return uppercase)', () => {
    expect(() =>
      assertResolvedAddressAllowed('attacker.example.com', 'FE80::1', {})
    ).toThrow(/private/);
  });
});

describe('isPrivateAddress', () => {
  it('identifies RFC1918', () => {
    expect(isPrivateAddress('10.0.0.1')).toBe(true);
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('172.20.0.1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });

  it('identifies link-local', () => {
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
  });

  it('identifies IPv6 loopback and unique-local', () => {
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fc00::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('strips IPv4-mapped IPv6 prefix', () => {
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('identifies CGNAT (100.64.0.0/10) including boundaries', () => {
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
    expect(isPrivateAddress('100.127.255.254')).toBe(true);
    expect(isPrivateAddress('100.63.255.255')).toBe(false); // just below
    expect(isPrivateAddress('100.128.0.1')).toBe(false);    // just above
  });

  it('rejects all of 127.0.0.0/8 (loopback range)', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('127.5.5.5')).toBe(true);
  });

  it('rejects all of 0.0.0.0/8 (this-network)', () => {
    expect(isPrivateAddress('0.0.0.0')).toBe(true);
    expect(isPrivateAddress('0.1.2.3')).toBe(true);
  });
});

describe('isPrivateAddress IPv6 coverage', () => {
  const cases: Array<[string, string]> = [
    ['[::]', 'unspecified'],
    ['[::ffff:7f00:1]', 'IPv4-mapped loopback hex'],
    ['[::ffff:127.0.0.1]', 'IPv4-mapped loopback dotted'],
    ['[::ffff:a00:1]', 'IPv4-mapped 10/8 hex'],
    ['[::ffff:c0a8:101]', 'IPv4-mapped 192.168.1.1 hex'],
    ['[64:ff9b::a00:1]', 'NAT64 wrapping 10.0.0.1'],
    ['[2002:a00::]', '6to4 wrapping 10/8'],
    ['[2002:7f00::]', '6to4 wrapping 127/8'],
    ['[fec0::1]', 'deprecated site-local'],
    ['[0:0:0:0:0:ffff:c0a8:101]', 'fully expanded mapped 192.168.1.1'],
  ];

  for (const [input, label] of cases) {
    it(`rejects ${label}: ${input}`, () => {
      const url = `http://${input}/`;
      const result = validateURL(url, { allowPrivateIPs: false });
      expect(result.valid).toBe(false);
    });
  }

  it('still allows public IPv6 (Cloudflare DNS 2606:4700:4700::1111)', () => {
    const result = validateURL('http://[2606:4700:4700::1111]/', { allowPrivateIPs: false });
    expect(result.valid).toBe(true);
  });

  it('isPrivateAddress handles bracketed and unbracketed IPv6 forms', () => {
    expect(isPrivateAddress('[::1]')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('[fe80::1]')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
  });

  it('isPrivateAddress returns false for malformed IPv6 rather than crashing', () => {
    expect(() => isPrivateAddress('[zz::]')).not.toThrow();
    expect(() => isPrivateAddress('[::g]')).not.toThrow();
    expect(() => isPrivateAddress('[1:2:3:4:5:6:7:8:9]')).not.toThrow();
    expect(isPrivateAddress('[zz::]')).toBe(false);
    expect(isPrivateAddress('[::g]')).toBe(false);
  });
});
