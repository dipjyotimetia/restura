import { createOpenAiStyleDecoder } from './openai';
import type { ModelInfo, ProviderModule } from './types';

/**
 * OpenRouter is OpenAI-API-compatible: same request shape, same SSE format.
 * We reuse the OpenAI decoder, but feed it OUR price table so cost is estimated
 * against OpenRouter's slash-namespaced model ids (passing through the OpenAI
 * module's decoder would look them up in OpenAI's list, miss, and report $0).
 */
// Prices/ids from openrouter.ai/api/v1/models (checked 2026-09-30). OpenRouter
// uses dotted ids (`claude-sonnet-5.5`), unlike Anthropic's own dashed ones.
const MODELS: ModelInfo[] = [
  {
    id: 'anthropic/claude-sonnet-5.5',
    label: 'Claude Sonnet 5.5 (via OpenRouter)',
    contextWindow: 1_000_000,
    inputUSDPerMTok: 2.0,
    outputUSDPerMTok: 10.0,
    cacheReadUSDPerMTok: 0.2,
  },
  {
    id: 'anthropic/claude-opus-5.5',
    label: 'Claude Opus 5.5 (via OpenRouter)',
    contextWindow: 1_000_000,
    inputUSDPerMTok: 4.0,
    outputUSDPerMTok: 20.0,
    cacheReadUSDPerMTok: 0.2,
  },
  {
    id: 'openai/gpt-6.1-sol',
    label: 'GPT-6.1 Sol (via OpenRouter)',
    contextWindow: 1_050_000,
    inputUSDPerMTok: 2.0,
    outputUSDPerMTok: 10.0,
    cacheReadUSDPerMTok: 0.1,
  },
  {
    id: 'openai/gpt-5.4-mini',
    label: 'GPT-5.4 mini (via OpenRouter)',
    contextWindow: 400_000,
    inputUSDPerMTok: 0.75,
    outputUSDPerMTok: 4.5,
    cacheReadUSDPerMTok: 0.075,
  },
  {
    id: 'google/gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    contextWindow: 1_048_576,
    inputUSDPerMTok: 0.75,
    outputUSDPerMTok: 3.75,
    cacheReadUSDPerMTok: 0.075,
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct',
    label: 'Llama 3.3 70B',
    contextWindow: 131_072,
    inputUSDPerMTok: 0.1,
    outputUSDPerMTok: 0.32,
  },
];

export const openrouterModule: ProviderModule = {
  provider: 'openrouter',
  models: MODELS,
  // OpenAI-compatible wire format, but cost is estimated against OUR MODELS.
  createDecoder: (model) => createOpenAiStyleDecoder(model, MODELS),
};
