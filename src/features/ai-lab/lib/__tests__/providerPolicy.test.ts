import { describe, expect, it } from 'vitest';
import { effectiveProviderBaseUrl, providerRequiresApiKey } from '../providerPolicy';

describe('provider policy', () => {
  it('uses a provider default base URL when a saved configuration omits one', () => {
    expect(effectiveProviderBaseUrl({ provider: 'openai' } as never)).toBe(
      'https://api.openai.com'
    );
  });

  it('requires credentials only for remote credential-backed providers', () => {
    expect(providerRequiresApiKey('openai')).toBe(true);
    expect(providerRequiresApiKey('ollama')).toBe(false);
  });
});
