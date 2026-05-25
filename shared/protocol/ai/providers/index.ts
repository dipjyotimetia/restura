import type { Provider } from '@shared/protocol/ai/types';
import type { ProviderModule } from './types';
import { openaiModule } from './openai';
import { anthropicModule } from './anthropic';
import { openrouterModule } from './openrouter';

const REGISTRY: Record<Provider, ProviderModule> = {
  openai: openaiModule,
  anthropic: anthropicModule,
  openrouter: openrouterModule,
};

export const ALL_PROVIDERS: Provider[] = ['openai', 'anthropic', 'openrouter'];

export function getProviderModule(provider: Provider): ProviderModule {
  return REGISTRY[provider];
}

export { openaiModule, anthropicModule, openrouterModule };
export type { ProviderModule, StreamDecoder, ModelInfo } from './types';
