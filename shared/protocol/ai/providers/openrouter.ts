import { createOpenAiStyleDecoder } from './openai';
import type { ModelInfo, ProviderModule } from './types';

/**
 * OpenRouter is OpenAI-API-compatible: same request shape, same SSE format.
 * We reuse the OpenAI decoder, but feed it OUR price table so cost is estimated
 * against OpenRouter's slash-namespaced model ids (passing through the OpenAI
 * module's decoder would look them up in OpenAI's list, miss, and report $0).
 */
const MODELS: ModelInfo[] = [
  { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (via OpenRouter)', contextWindow: 200_000, inputUSDPerMTok: 3.0, outputUSDPerMTok: 15.0 },
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini (via OpenRouter)', contextWindow: 128_000, inputUSDPerMTok: 0.15, outputUSDPerMTok: 0.60 },
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', contextWindow: 1_000_000, inputUSDPerMTok: 0.30, outputUSDPerMTok: 2.50 },
  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B', contextWindow: 128_000, inputUSDPerMTok: 0.59, outputUSDPerMTok: 0.79 },
];

export const openrouterModule: ProviderModule = {
  provider: 'openrouter',
  models: MODELS,
  // OpenAI-compatible wire format, but cost is estimated against OUR MODELS.
  createDecoder: (model) => createOpenAiStyleDecoder(model, MODELS),
};
