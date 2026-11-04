import { describe, expect, it } from 'vitest';
import {
  assertResolvedAddressAllowed,
  isCloudMetadataHost,
  validateURL,
} from '../../shared/protocol/url-validation';

/**
 * Cloud metadata / credential endpoints must stay unreachable even when an
 * operator opts in to private networks (`ALLOW_PRIVATE_IPS=true`), as a URL
 * literal and as a DNS-resolved address.
 */
const METADATA_ADDRESSES: Array<[string, string]> = [
  ['169.254.169.254', 'AWS / Azure / GCP / DO instance metadata'],
  ['169.254.170.2', 'AWS ECS task credentials'],
  ['169.254.169.253', 'AWS VPC DNS resolver'],
  ['169.254.169.123', 'AWS time sync'],
  ['100.100.100.200', 'Alibaba Cloud metadata'],
  ['fd00:ec2::254', 'AWS IMDS IPv6'],
  ['fd00:ec2::23', 'AWS IMDS IPv6 (Nitro)'],
  ['fd20:ce::254', 'GCE metadata IPv6'],
  ['::ffff:169.254.170.2', 'v4-mapped ECS credentials'],
  ['::ffff:100.100.100.200', 'v4-mapped Alibaba metadata'],
];

function urlFor(address: string): string {
  return address.includes(':') ? `http://[${address}]/latest` : `http://${address}/latest`;
}

describe('cloud metadata / credential endpoints are hard-blocked', () => {
  it.each(METADATA_ADDRESSES)('isCloudMetadataHost(%s) — %s', (address) => {
    expect(isCloudMetadataHost(address)).toBe(true);
  });

  it.each(METADATA_ADDRESSES)('validateURL refuses %s with allowPrivateIPs (%s)', (address) => {
    const result = validateURL(urlFor(address), { allowPrivateIPs: true, allowLocalhost: true });
    expect(result.valid).toBe(false);
  });

  it.each(METADATA_ADDRESSES)(
    'assertResolvedAddressAllowed refuses a name resolving to %s (%s)',
    (address) => {
      expect(() =>
        assertResolvedAddressAllowed('rebind.example', address, {
          allowLocalhost: true,
          allowPrivateLiteralHost: true,
        })
      ).toThrow(/metadata/i);
    }
  );

  it.each(['169.254.1.1', '100.100.100.199', 'fd00:ec2::1', '10.0.0.1'])(
    'leaves the neighbouring private address %s to the ALLOW_PRIVATE_IPS policy',
    (address) => {
      expect(isCloudMetadataHost(address)).toBe(false);
      expect(validateURL(urlFor(address), { allowPrivateIPs: true }).valid).toBe(true);
    }
  );
});
