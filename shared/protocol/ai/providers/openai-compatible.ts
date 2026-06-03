import { createOpenAiStyleDecoder } from './openai';
import type { ModelInfo, ProviderModule } from './types';

/**
 * Generic OpenAI-compatible endpoint: user supplies a base URL + model id
 * (covers LM Studio, vLLM, llama.cpp server, LocalAI, Together, Groq,
 * Fireworks, …). Same SSE wire format as OpenAI, so we reuse that decoder.
 *
 * Models are discovered at runtime (`/v1/models`), so the static list is empty.
 * Pricing is genuinely unknown for arbitrary gateways — the empty table yields
 * cost 0 from the decoder, and the AI Lab marks such cells "unknown" rather than
 * presenting a misleading $0.00 (a paid gateway is not free). See
 * src/features/ai-lab — pricingKnown is tracked per provider config.
 */
const MODELS: ModelInfo[] = [];

export const openaiCompatibleModule: ProviderModule = {
  provider: 'openai-compatible',
  models: MODELS,
  createDecoder: (model) => createOpenAiStyleDecoder(model, MODELS),
};
