// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { validateURL } from '@shared/protocol/url-validation';
import { isLocalProvider, type Provider } from '@shared/protocol/ai/types';

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
