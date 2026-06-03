import { createOpenAiStyleDecoder } from './openai';
import type { ModelInfo, ProviderModule } from './types';

/**
 * Ollama exposes an OpenAI-compatible API at `${baseUrl}/v1/chat/completions`
 * (default base http://localhost:11434). Same SSE wire format as OpenAI, so we
 * reuse that decoder. Models are discovered at runtime (`/api/tags` — see
 * model-discovery.ts), so the static list is empty. Local inference is free:
 * the empty price table makes `estimateCost` return 0, which is correct here.
 */
const MODELS: ModelInfo[] = [];

export const ollamaModule: ProviderModule = {
  provider: 'ollama',
  models: MODELS,
  createDecoder: (model) => createOpenAiStyleDecoder(model, MODELS),
};
