// @vitest-environment node

import { isLocalProvider, type Provider } from '@shared/protocol/ai/types';
import { validateURL } from '@shared/protocol/url-validation';
import { describe, expect, it } from 'vitest';
import { resolveSafeAddress } from '../../electron/main/security/safe-connect';

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

  it('local providers still cannot reach non-loopback private ranges', () => {
    expect(checkAsHandler('ollama', 'http://192.168.1.5:11434/').valid).toBe(false);
    expect(checkAsHandler('ollama', 'http://10.0.0.5:11434/').valid).toBe(false);
    expect(checkAsHandler('openai-compatible', 'http://169.254.169.254/').valid).toBe(false);
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
    resolveSafeAddress(url, { allowLocalhost: isLocalProvider(provider) });

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
