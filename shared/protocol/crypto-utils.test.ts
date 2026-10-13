import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { md5Hex, sha256Hex, sha256HexSync } from './crypto-utils';

describe('sha256HexSync', () => {
  it('matches the FIPS 180-4 test vectors, node:crypto and the async digest', async () => {
    expect(sha256HexSync('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    expect(sha256HexSync('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    const long = 'é'.repeat(1000);
    expect(sha256HexSync(long)).toBe(createHash('sha256').update(long, 'utf8').digest('hex'));
    expect(sha256HexSync(long)).toBe(await sha256Hex(long));
  });
});

describe('md5Hex', () => {
  it('matches the RFC 1321 test suite', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(
      md5Hex('12345678901234567890123456789012345678901234567890123456789012345678901234567890')
    ).toBe('57edf4a22be3c955ac49da2e2107b67a');
  });

  it('hashes UTF-8 bytes (node:crypto oracle), across block boundaries', () => {
    const inputs = ['é', 'é'.normalize('NFD'), 'x'.repeat(55), 'x'.repeat(56), '€'.repeat(300)];
    for (const input of inputs) {
      expect(md5Hex(input)).toBe(createHash('md5').update(input, 'utf8').digest('hex'));
    }
  });
});
