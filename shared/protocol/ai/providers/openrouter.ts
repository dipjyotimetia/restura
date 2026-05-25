import { openaiModule } from './openai';
import type { ModelInfo, ProviderModule } from './types';

/**
 * OpenRouter is OpenAI-API-compatible: same request shape, same SSE format.
 * We reuse the OpenAI decoder verbatim. Only the model list and pricing
 * differ.
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
  // OpenAI-compatible: same wire format, same decoder.
  createDecoder: (model) => openaiModule.createDecoder(model),
};
