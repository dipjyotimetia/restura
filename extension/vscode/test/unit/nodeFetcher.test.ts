import { describe, expect, it } from 'vitest';
import { assertHostSafe } from '../../src/util/nodeFetcher';

const STRICT = { allowLocalhost: false, allowPrivateIPs: false };

describe('assertHostSafe (SSRF pre-flight DNS guard)', () => {
  it('skips literal IP hosts — validateURL owns those', async () => {
    // Literal IPs are not re-resolved here; executeHttpProxy's validateURL
    // decides them. So this must NOT throw even for a private literal.
    await expect(assertHostSafe('http://127.0.0.1:3000/x', STRICT)).resolves.toBeUndefined();
    await expect(assertHostSafe('http://10.0.0.5/x', STRICT)).resolves.toBeUndefined();
    await expect(assertHostSafe('http://[::1]/x', STRICT)).resolves.toBeUndefined();
  });

  it('blocks a hostname that resolves to loopback when localhost is disallowed', async () => {
    await expect(assertHostSafe('http://localhost/x', STRICT)).rejects.toThrow();
  });

  it('allows a hostname resolving to loopback when localhost is permitted', async () => {
    await expect(
      assertHostSafe('http://localhost/x', { allowLocalhost: true, allowPrivateIPs: false })
    ).resolves.toBeUndefined();
  });

  it('ignores unparseable URLs (validateURL rejects them upstream)', async () => {
    await expect(assertHostSafe('not a url', STRICT)).resolves.toBeUndefined();
  });
});
