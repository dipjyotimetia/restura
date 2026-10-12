import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex, sha256HexSync } from './crypto-utils';

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
