// @vitest-environment node

import { isLocalProvider, type Provider } from '@shared/protocol/ai/types';
import { validateURL } from '@shared/protocol/url-validation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSafeAddress } from '../../electron/main/security/safe-connect';

const mockLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: mockLookup }));

/**
 * The AI Lab supports local LLM runtimes (Ollama on 127.0.0.1) that the rest of
 * the app's SSRF guard rejects by default. The carve-out is deliberately narrow:
 * the handler computes `allowLocalhost = isLocalProvider(provider)` and passes it
 * to the SAME shared guard everything else uses (no bespoke bypass). This test
 * pins that policy: cloud providers can never reach localhost/private hosts, and
 * the local carve-out relaxes loopback ONLY — LAN/private ranges stay blocked.
 */
function checkAsHandler(provider: Provider, url: string) {
  return validateURL(url, { allowLocalhost: isLocalProvider(provider), allowPrivateIPs: false });
}

describe('AI Lab localhost SSRF carve-out', () => {
  it('cloud providers cannot target localhost', () => {
    expect(checkAsHandler('openai', 'http://localhost:11434/v1/chat/completions').valid).toBe(
      false
    );
    expect(checkAsHandler('anthropic', 'http://127.0.0.1:11434/v1/chat/completions').valid).toBe(
      false
    );
    expect(checkAsHandler('openrouter', 'http://[::1]:11434/').valid).toBe(false);
  });

  it('a base-URL override on a cloud provider cannot smuggle a localhost target', () => {
    // Even though the user typed a base URL, the provider kind (cloud) drives the
    // flag — the override is validated with allowLocalhost:false.
    expect(checkAsHandler('openai', 'http://localhost:8080/v1/chat/completions').valid).toBe(false);
  });

  it('local providers may reach loopback', () => {
    expect(checkAsHandler('ollama', 'http://localhost:11434/v1/chat/completions').valid).toBe(true);
    expect(checkAsHandler('ollama', 'http://127.0.0.1:11434/v1/chat/completions').valid).toBe(true);
    expect(
      checkAsHandler('openai-compatible', 'http://localhost:1234/v1/chat/completions').valid
    ).toBe(true);
  });

  it('cloud providers still cannot reach private ranges or metadata via the string policy', () => {
    expect(checkAsHandler('openai', 'http://192.168.1.5:11434/').valid).toBe(false);
    expect(checkAsHandler('anthropic', 'http://10.0.0.5:11434/').valid).toBe(false);
    expect(checkAsHandler('openai', 'http://169.254.169.254/').valid).toBe(false);
  });

  it('local providers still cannot reach cloud metadata endpoints', () => {
    expect(checkAsHandler('ollama', 'http://metadata.google.internal/').valid).toBe(false);
  });
});

/**
 * The checks above use `validateURL`, but the AI handlers pin via
 * `makePinnedFetcher → resolveSafeAddress`, which does NOT run `validateURL`.
 * Before the fix, the literal-IP short-circuit in `resolveSafeAddress` honored a
 * private literal regardless of `allowLocalhost`, so a cloud provider reached
 * 127.0.0.1 / 169.254.169.254 / RFC1918 — the test above passed while the
 * runtime was unsafe. These exercise the real runtime guard.
 */
describe('AI Lab carve-out — actual runtime guard (resolveSafeAddress)', () => {
  const asHandler = (provider: Provider, url: string) =>
    resolveSafeAddress(url, {
      allowLocalhost: isLocalProvider(provider),
      ...(isLocalProvider(provider) ? { localRuntime: true } : {}),
    });

  it('cloud provider cannot reach loopback / metadata / RFC1918 literal IPs', async () => {
    await expect(asHandler('openai', 'http://127.0.0.1/')).rejects.toThrow();
    await expect(asHandler('openai', 'http://169.254.169.254/')).rejects.toThrow();
    await expect(asHandler('anthropic', 'http://10.0.0.5/')).rejects.toThrow();
    await expect(asHandler('openrouter', 'http://192.168.1.5/')).rejects.toThrow();
  });

  it('local provider may still reach the loopback literal it was configured with', async () => {
    await expect(asHandler('ollama', 'http://127.0.0.1:11434/')).resolves.toMatchObject({
      ip: '127.0.0.1',
    });
  });

  it('cloud metadata endpoint is blocked even when localhost is allowed', async () => {
    await expect(asHandler('ollama', 'http://169.254.169.254/')).rejects.toThrow();
    await expect(asHandler('ollama', 'http://[::ffff:169.254.169.254]/')).rejects.toThrow();
    await expect(asHandler('ollama', 'http://metadata.google.internal./')).rejects.toThrow();
  });
});

/**
 * Local runtime kinds (ollama, openai-compatible) allow loopback + RFC1918 —
 * identically for literal IPs and DNS-resolved hostnames — and block ALL of
 * 169.254.0.0/16 plus IPv6 link-local. This is independent of the global
 * Settings -> Security toggles (the handler never consults them); cloud kinds
 * keep the strict guard.
 */
describe('AI Lab local-runtime policy (#1033)', () => {
  beforeEach(() => mockLookup.mockReset());
  const asHandler = (provider: Provider, url: string) =>
    resolveSafeAddress(url, {
      allowLocalhost: isLocalProvider(provider),
      ...(isLocalProvider(provider) ? { localRuntime: true } : {}),
    });
  const resolvesTo = (...addresses: string[]) =>
    mockLookup.mockResolvedValueOnce(
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
    );

  it('allows RFC1918 literals for local kinds', async () => {
    for (const ip of ['10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.5']) {
      await expect(asHandler('ollama', `http://${ip}:11434/`)).resolves.toMatchObject({ ip });
      await expect(asHandler('openai-compatible', `http://${ip}:1234/`)).resolves.toMatchObject({
        ip,
      });
    }
  });

  it('hostname resolving to RFC1918 behaves exactly like the literal (pinned to the checked IP)', async () => {
    resolvesTo('192.168.1.5');
    await expect(asHandler('ollama', 'http://gpu-box.lan:11434/')).resolves.toMatchObject({
      host: 'gpu-box.lan',
      ip: '192.168.1.5',
    });
    resolvesTo('10.0.0.7');
    await expect(
      asHandler('openai-compatible', 'http://llm.internal.example:1234/')
    ).resolves.toMatchObject({ ip: '10.0.0.7' });
  });

  it('blocks every 169.254.0.0/16 literal for local kinds, not just the metadata IP', async () => {
    for (const ip of ['169.254.170.2', '169.254.0.1', '169.254.169.253']) {
      await expect(asHandler('ollama', `http://${ip}/`)).rejects.toThrow();
      await expect(asHandler('openai-compatible', `http://${ip}/`)).rejects.toThrow();
    }
    await expect(asHandler('ollama', 'http://[::ffff:169.254.170.2]/')).rejects.toThrow();
  });

  it('blocks IPv6 link-local literals for local kinds', async () => {
    await expect(asHandler('ollama', 'http://[fe80::1]:11434/')).rejects.toThrow();
    await expect(asHandler('openai-compatible', 'http://[febf::2]/')).rejects.toThrow();
  });

  it('blocks hostnames resolving to link-local or metadata addresses', async () => {
    resolvesTo('169.254.170.2');
    await expect(asHandler('ollama', 'http://sneaky.example:11434/')).rejects.toThrow();
    resolvesTo('fe80::1');
    await expect(asHandler('ollama', 'http://sneaky6.example:11434/')).rejects.toThrow();
    resolvesTo('169.254.169.254');
    await expect(asHandler('ollama', 'http://sneaky-md.example/')).rejects.toThrow();
  });

  it('fails closed when any resolved record is link-local', async () => {
    resolvesTo('192.168.1.5', '169.254.170.2');
    await expect(asHandler('ollama', 'http://mixed.example:11434/')).rejects.toThrow();
  });

  it('still allows loopback hostnames/literals for local kinds', async () => {
    resolvesTo('127.0.0.1');
    await expect(asHandler('ollama', 'http://localhost:11434/')).resolves.toMatchObject({
      ip: '127.0.0.1',
    });
    await expect(asHandler('ollama', 'http://[::1]:11434/')).resolves.toMatchObject({ ip: '::1' });
  });

  it('cloud kinds keep the strict guard for literals and resolved hostnames', async () => {
    await expect(asHandler('openai', 'http://192.168.1.5/')).rejects.toThrow();
    resolvesTo('192.168.1.5');
    await expect(asHandler('anthropic', 'http://gpu-box.lan/')).rejects.toThrow();
    resolvesTo('127.0.0.1');
    await expect(asHandler('openrouter', 'http://rebind.example/')).rejects.toThrow();
  });
});
