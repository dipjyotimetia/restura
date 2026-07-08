import { createOpenAiStyleDecoder } from './openai';
import type { ModelInfo, ProviderModule } from './types';

/**
 * HuggingFace Inference Providers (router.huggingface.co) exposes an
 * OpenAI-compatible Chat Completions API, so we reuse the OpenAI SSE decoder.
 *
 * Models are discovered at runtime via `GET /v1/models` (see
 * model-discovery.ts → fetchHuggingFaceModels), so the static list is empty.
 * Pricing is genuinely unknown — HF bills per upstream provider and model, and
 * the discovery endpoint does not return per-token prices — so the empty price
 * table makes `estimateCost` return 0. The AI Lab surfaces that as "unknown"
 * (not "$0.00") because `pricingKnown` defaults to false for huggingface
 * providers in the store (see useAiLabStore.ts). A future discovery enrichment
 * that returns per-model pricing can flip that per-config flag.
 */
const MODELS: ModelInfo[] = [];

export const huggingfaceModule: ProviderModule = {
  provider: 'huggingface',
  models: MODELS,
  createDecoder: (model) => createOpenAiStyleDecoder(model, MODELS),
};
