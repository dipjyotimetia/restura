import type { Provider } from '@shared/protocol/ai/types';
import type { AiLabProviderConfig } from '../types';

export const PROVIDER_DEFAULT_BASE: Record<Provider, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  openrouter: 'https://openrouter.ai/api',
  ollama: 'http://localhost:11434',
  huggingface: 'https://router.huggingface.co',
  'openai-compatible': '',
};

export function effectiveProviderBaseUrl(config: AiLabProviderConfig): string {
  return config.baseUrl || PROVIDER_DEFAULT_BASE[config.provider];
}

export function providerRequiresApiKey(provider: Provider): boolean {
  return (
    provider === 'openai' ||
    provider === 'anthropic' ||
    provider === 'openrouter' ||
    provider === 'huggingface'
  );
}
