import {
  isCloudMetadataHost,
  isLoopbackAddress,
  validateURL,
} from '@shared/protocol/url-validation';
import { describe, expect, it } from 'vitest';

const check = (host: string, opts: Parameters<typeof validateURL>[1]) =>
  validateURL(`kafka://${host}:9092`, { allowedSchemes: ['kafka:'], ...opts }).valid;

describe('IPv6 / loopback normalisation in validateURL', () => {
  const noLocal = { allowLocalhost: false, allowPrivateIPs: true };

  it.each([
    '[::1]',
    '[::]',
    '[::ffff:127.0.0.1]',
    '[::FFFF:7F00:1]',
    '[64:ff9b::7f00:1]',
    '[2002:7f00:1::]',
    '[::ffff:0.0.0.0]',
    '[::7f00:1]',
    '127.0.0.2',
    '0.0.0.0',
    '127.0.0.1',
  ])('blocks %s when localhost is disallowed', (host) => {
    expect(check(host, noLocal)).toBe(false);
  });

  it('allows loopback forms when localhost is allowed', () => {
    expect(check('[::1]', { allowLocalhost: true, allowPrivateIPs: true })).toBe(true);
  });

  it('pins: [::1] is allowed with allowLocalhost and no private IPs (same as 127.0.0.1)', () => {
    const opts = { allowLocalhost: true, allowPrivateIPs: false };
    expect(check('127.0.0.1', opts)).toBe(true);
    expect(check('[::1]', opts)).toBe(true);
  });

  it('allows a public IPv6 literal', () => {
    expect(check('[2001:db8::1]', noLocal)).toBe(true);
  });

  it.each(['[::7f00:1]', '[::a9fe:a9fe]', '[::a00:1]', '[fd00::1]', '[fe80::1]'])(
    'blocks private/embedded form %s under strict policy',
    (host) => {
      expect(check(host, { allowLocalhost: false, allowPrivateIPs: false })).toBe(false);
    }
  );

  it.each([
    '[::a9fe:a9fe]',
    '[fd00:ec2::254]',
    '[FD00:EC2:0:0:0:0:0:254]',
    '[fd00:ec2:0::254]',
    '[fd20:ce::254]',
    '[fd20:00ce:0:0:0:0:0:254]',
  ])('blocks metadata form %s even when private IPs are allowed', (host) => {
    expect(check(host, { allowLocalhost: true, allowPrivateIPs: true })).toBe(false);
    expect(isCloudMetadataHost(host)).toBe(true);
  });

  it('does not flag neighbouring ULA addresses as metadata', () => {
    expect(isCloudMetadataHost('[fd00:ec2::255]')).toBe(false);
    expect(isCloudMetadataHost('[fd00:ec3::254]')).toBe(false);
  });

  it('isLoopbackAddress covers unspecified and embedded loopback', () => {
    for (const h of ['::', '[::1]', '::ffff:7f00:1', '::7f00:1', '0.0.0.0', '127.0.0.9']) {
      expect(isLoopbackAddress(h)).toBe(true);
    }
    expect(isLoopbackAddress('2001:db8::1')).toBe(false);
  });

  it.each(['2130706433', '127.1', '0', '0x7f.1', '017700000001', '0x7f000001', '127.0.1'])(
    'blocks non-canonical IPv4 loopback %s when localhost is disallowed',
    (host) => {
      expect(check(host, noLocal)).toBe(false);
    }
  );

  it.each(['2852039166', '169.254.43518', '0xa9fea9fe', '0251.0376.0251.0376'])(
    'blocks non-canonical metadata IPv4 %s',
    (host) => {
      expect(check(host, { allowLocalhost: true, allowPrivateIPs: true })).toBe(false);
    }
  );

  it('blocks non-canonical private IPv4 when private IPs are disallowed', () => {
    const opts = { allowLocalhost: true, allowPrivateIPs: false };
    expect(check('167772161', opts)).toBe(false);
    expect(check('10.1', opts)).toBe(false);
  });

  it('does not treat a public non-canonical IPv4 or a dotted hostname as private', () => {
    expect(check('134744072', noLocal)).toBe(true);
    expect(check('127.example.com', noLocal)).toBe(true);
  });

  it('matches custom bracketed IPv6 blockedHostnames entries', () => {
    const r = validateURL('kafka://[2001:db8::1]:9092', {
      allowedSchemes: ['kafka:'],
      allowLocalhost: true,
      allowPrivateIPs: true,
      blockedHostnames: ['[2001:db8::1]'],
    });
    expect(r.valid).toBe(false);
  });
});
