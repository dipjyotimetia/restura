// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted; we need the lookup fn defined before hoisting too, so
// wrap it in vi.hoisted (which runs before any import/mock).
const { mockLookup } = vi.hoisted(() => {
  return { mockLookup: vi.fn() };
});

vi.mock('node:dns/promises', () => ({
  lookup: mockLookup,
}));

import { assertHostnameSafe, assertUrlHostnameSafe } from '../security/dns-guard';

describe('dns-guard', () => {
  beforeEach(() => {
    mockLookup.mockReset();
  });

  describe('assertHostnameSafe', () => {
    it('passes an IP literal without DNS lookup when the literal is public', async () => {
      await expect(assertHostnameSafe('1.2.3.4', { allowLocalhost: false })).resolves.toBeDefined();
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('ACCEPTS a private IP literal (explicit user-typed host gets the allowPrivateLiteralHost exception)', async () => {
      // Literal-IP path: with `allowLocalhost: false`, a private literal goes
      // through `assertResolvedAddressAllowed`; private literals get the
      // `allowPrivateLiteralHost` exception (user typed it explicitly).
      // The function still skips DNS, but accepts private literals when
      // they're explicit. This documents the actual policy — if a future
      // change tightens it, this test will start failing and the change
      // needs an ADR update.
      await expect(
        assertHostnameSafe('10.0.0.1', { allowLocalhost: false })
      ).resolves.toBeDefined();
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('resolves a hostname and accepts a public result', async () => {
      mockLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
      await expect(
        assertHostnameSafe('example.com', { allowLocalhost: false })
      ).resolves.toBeDefined();
      expect(mockLookup).toHaveBeenCalledWith('example.com', { all: true });
    });

    it('rejects when DNS returns a private address (rebind-style)', async () => {
      // A public hostname that resolves to a private address — this is the
      // SSRF case the guard exists for.
      mockLookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
      await expect(
        assertHostnameSafe('attacker.example.com', { allowLocalhost: false })
      ).rejects.toThrow(/private address/);
    });

    it('rejects when DNS returns a cloud-metadata link-local address', async () => {
      mockLookup.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
      await expect(
        assertHostnameSafe('rebind.example.com', { allowLocalhost: false })
      ).rejects.toThrow(/metadata/);
    });

    it('rejects when DNS returns IPv4-mapped IPv6 wrapping a private v4', async () => {
      mockLookup.mockResolvedValueOnce([{ address: '::ffff:10.0.0.1', family: 6 }]);
      await expect(
        assertHostnameSafe('mapped.example.com', { allowLocalhost: false })
      ).rejects.toThrow(/private address/);
    });

    it('rejects when ANY record in a multi-record response is private', async () => {
      // Multi-record DNS — the guard MUST reject the whole lookup if any
      // record is bad, not just the first. This is a documented invariant.
      mockLookup.mockResolvedValueOnce([
        { address: '93.184.216.34', family: 4 }, // public — fine
        { address: '10.0.0.5', family: 4 }, // private — must reject the lookup
      ]);
      await expect(
        assertHostnameSafe('mixed.example.com', { allowLocalhost: false })
      ).rejects.toThrow(/private address/);
    });

    it('allows localhost when allowLocalhost is true', async () => {
      mockLookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
      await expect(
        assertHostnameSafe('localhost', { allowLocalhost: true })
      ).resolves.toBeDefined();
    });

    it('accepts a DNS-resolved private address when allowPrivateIPs is true (the Security opt-in)', async () => {
      // Default rejects this (rebind-style, covered above); the opt-in permits
      // a hostname pointing at an RFC-1918 target for internal-network use.
      mockLookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
      await expect(
        assertHostnameSafe('internal.example.com', { allowLocalhost: true, allowPrivateIPs: true })
      ).resolves.toBeDefined();
    });

    it('STILL rejects a DNS-resolved metadata address even with allowPrivateIPs true', async () => {
      // The crux invariant: the private-IP opt-in must never open cloud metadata.
      mockLookup.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
      await expect(
        assertHostnameSafe('rebind.example.com', { allowLocalhost: true, allowPrivateIPs: true })
      ).rejects.toThrow(/metadata/);
    });

    it('surfaces DNS lookup failures as an error', async () => {
      mockLookup.mockRejectedValueOnce(new Error('ENOTFOUND nonexistent.example'));
      await expect(
        assertHostnameSafe('nonexistent.example', { allowLocalhost: false })
      ).rejects.toThrow(/DNS lookup failed/);
    });

    it('ACCEPTS IPv6 ULA literal hostnames (user-typed literal exception, parallel to private-v4 literals)', async () => {
      // ULA `fc00::/7` is private. As a literal the user explicitly typed,
      // the guard allows it (same as private v4 literal).
      await expect(assertHostnameSafe('fc00::1', { allowLocalhost: false })).resolves.toBeDefined();
    });
  });

  describe('assertUrlHostnameSafe', () => {
    it('rejects URLs whose scheme is not in the allowed list', async () => {
      await expect(
        assertUrlHostnameSafe('javascript://evil/', { allowLocalhost: false })
      ).rejects.toThrow();
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('rejects blocked hostnames before any DNS work', async () => {
      await expect(
        assertUrlHostnameSafe('http://metadata.google.internal/', { allowLocalhost: false })
      ).rejects.toThrow();
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('rejects 169.254.169.254 literal before any DNS work', async () => {
      await expect(
        assertUrlHostnameSafe('http://169.254.169.254/latest/meta-data/', {
          allowLocalhost: false,
        })
      ).rejects.toThrow();
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('honors allowedSchemes overrides (e.g., ws/wss)', async () => {
      mockLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
      await expect(
        assertUrlHostnameSafe('wss://example.com/socket', {
          allowLocalhost: false,
          allowedSchemes: ['ws:', 'wss:'],
        })
      ).resolves.toBeUndefined();
    });

    it('runs both URL policy and DNS check on a public URL', async () => {
      mockLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
      await expect(
        assertUrlHostnameSafe('https://example.com/api', { allowLocalhost: false })
      ).resolves.toBeUndefined();
      expect(mockLookup).toHaveBeenCalledOnce();
    });

    it('rejects a URL whose DNS lookup returns a private address', async () => {
      mockLookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
      await expect(
        assertUrlHostnameSafe('https://attacker-controlled.example.com/', {
          allowLocalhost: false,
        })
      ).rejects.toThrow(/private address/);
    });
  });
});
