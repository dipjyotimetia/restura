import type { CloudProvider, Provider } from '@shared/protocol/ai/types';
import { anthropicModule } from './anthropic';
import { huggingfaceModule } from './huggingface';
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
  huggingface: huggingfaceModule,
  'openai-compatible': openaiCompatibleModule,
};

/** Cloud providers with hardcoded-safe endpoints + known pricing (the chat panel). */
export const CLOUD_PROVIDERS: CloudProvider[] = ['openai', 'anthropic', 'openrouter'];

/** Local / self-hosted OpenAI-compatible runtimes (AI Lab, Electron-only). */
export const LOCAL_PROVIDERS: Provider[] = ['ollama', 'openai-compatible'];

/**
 * Cloud-style providers surfaced ONLY in the AI Lab (not the chat panel). Today
 * this is HuggingFace — a cloud gateway without a static price table, so it
 * doesn't belong in `CLOUD_PROVIDERS` (which the chat settings render and which
 * implies known pricing). Kept as its own list so the chat panel's curated set
 * stays untouched while the AI Lab provider picker enumerates the full union.
 */
export const AI_LAB_CLOUD_PROVIDERS: Provider[] = ['huggingface'];

/** Every provider the wire layer can route + decode. */
export const ALL_PROVIDERS: Provider[] = [
  ...CLOUD_PROVIDERS,
  ...LOCAL_PROVIDERS,
  ...AI_LAB_CLOUD_PROVIDERS,
];

export function getProviderModule(provider: Provider): ProviderModule {
  return REGISTRY[provider];
}

export {
  openaiModule,
  anthropicModule,
  openrouterModule,
  ollamaModule,
  huggingfaceModule,
  openaiCompatibleModule,
};
export type { ProviderModule, StreamDecoder, ModelInfo } from './types';
