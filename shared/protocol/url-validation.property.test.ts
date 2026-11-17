import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  isCloudMetadataHost,
  isLoopbackAddress,
  isPrivateAddress,
  validateURL,
} from './url-validation';

const runs = { numRuns: 80 };

const octet = fc.integer({ min: 0, max: 255 });
const dotted = fc.tuple(octet, octet, octet, octet).map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

describe('URL / SSRF properties', () => {
  it('validateURL is deterministic', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300, unit: 'grapheme' }), (raw) => {
        expect(validateURL(raw)).toEqual(validateURL(raw));
      }),
      runs
    );
  });

  it('treats an IPv4 address and its v4-mapped IPv6 form the same for privacy', () => {
    fc.assert(
      fc.property(dotted, (ip) => {
        expect(isPrivateAddress(`::ffff:${ip}`)).toBe(isPrivateAddress(ip));
        expect(isLoopbackAddress(`::ffff:${ip}`)).toBe(isLoopbackAddress(ip));
      }),
      runs
    );
  });

  it('counts every loopback form as private', () => {
    fc.assert(
      fc.property(octet, octet, octet, (b, c, d) => {
        const hosts = [`127.${b}.${c}.${d}`, `::ffff:127.${b}.${c}.${d}`];
        for (const host of hosts) {
          expect(isLoopbackAddress(host)).toBe(true);
          expect(isPrivateAddress(host)).toBe(true);
          expect(validateURL(`http://${host}/`, { allowLocalhost: false }).valid).toBe(false);
        }
      }),
      runs
    );
  });

  it('rejects the decimal form of a 127/8 address the same way as the dotted form', () => {
    fc.assert(
      fc.property(octet, octet, octet, (b, c, d) => {
        const decimal = ((127 << 24) + (b << 16) + (c << 8) + d) >>> 0;
        const dottedUrl = validateURL(`http://127.${b}.${c}.${d}/`);
        const decimalUrl = validateURL(`http://${decimal}/`);
        expect(decimalUrl.valid).toBe(dottedUrl.valid);
        expect(decimalUrl.valid).toBe(false);
      }),
      runs
    );
  });

  it('blocks cloud metadata even when private and localhost targets are allowed', () => {
    const hosts = [
      '169.254.169.254',
      '169.254.170.2',
      '169.254.169.253',
      '100.100.100.200',
      'metadata.google.internal',
      'metadata',
      'instance-data',
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...hosts),
        fc.string({ maxLength: 24, unit: 'grapheme' }).map((s) => s.replace(/[^a-z0-9]/gi, '')),
        fc.boolean(),
        (host, path, trailingDot) => {
          const name = trailingDot ? `${host}.` : host;
          expect(isCloudMetadataHost(name)).toBe(true);
          const urls = [`http://${name}/${path}`];
          // IPv6 in a URL is bracketed. The mapped form is only meaningful for
          // a literal address, and the trailing-dot form is a hostname.
          if (/^\d/.test(host) && !trailingDot) {
            urls.push(`http://[::ffff:${host}]/${path}`);
          }
          for (const url of urls) {
            const result = validateURL(url, {
              allowPrivateIPs: true,
              allowLocalhost: true,
            });
            expect(result.valid, url).toBe(false);
            if (!result.valid) expect(result.error, url).toMatch(/metadata/i);
          }
        }
      ),
      runs
    );
  });

  it('rejects non-http schemes under the default allowlist', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('javascript:', 'file:', 'data:', 'ftp:'),
        fc.webUrl(),
        (scheme, httpUrl) => {
          const rest = httpUrl.replace(/^https?:/i, '');
          const result = validateURL(`${scheme}${rest}`);
          expect(result.valid).toBe(false);
        }
      ),
      runs
    );
  });
});
