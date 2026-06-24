import type { CloudProvider, Provider } from '@shared/protocol/ai/types';
import { anthropicModule } from './anthropic';
import { ollamaModule } from './ollama';
import { openaiModule } from './openai';
import { openaiCompatibleModule } from './openai-compatible';
import { openrouterModule } from './openrouter';
import type { ProviderModule } from './types';

const REGISTRY: Record<Provider, ProviderModule> = {
  openai: openaiModule,
  anthropic: anthropicModule,
  openrouter: openrouterModule,
  ollama: ollamaModule,
  'openai-compatible': openaiCompatibleModule,
};

/** Cloud providers with hardcoded-safe endpoints + known pricing (the chat panel). */
export const CLOUD_PROVIDERS: CloudProvider[] = ['openai', 'anthropic', 'openrouter'];

/** Local / self-hosted OpenAI-compatible runtimes (AI Lab, Electron-only). */
export const LOCAL_PROVIDERS: Provider[] = ['ollama', 'openai-compatible'];

/** Every provider the wire layer can route + decode. */
export const ALL_PROVIDERS: Provider[] = [...CLOUD_PROVIDERS, ...LOCAL_PROVIDERS];

export function getProviderModule(provider: Provider): ProviderModule {
  return REGISTRY[provider];
}

export { openaiModule, anthropicModule, openrouterModule, ollamaModule, openaiCompatibleModule };
export type { ProviderModule, StreamDecoder, ModelInfo } from './types';
