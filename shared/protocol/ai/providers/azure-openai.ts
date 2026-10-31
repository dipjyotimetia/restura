import { createOpenAiStyleDecoder } from './openai';
import type { ModelInfo, ProviderModule } from './types';

/**
 * Azure OpenAI v1 API (`{resource}.openai.azure.com/openai/v1`): the OpenAI
 * Chat Completions wire format with an `api-key` header and the deployment
 * name as `model`, so the OpenAI SSE decoder applies unchanged.
 *
 * Deployments are customer-named and billed per agreement, so there is no
 * static price table: cost reads as unknown (pricingKnown=false).
 */
const MODELS: ModelInfo[] = [];

export const azureOpenAiModule: ProviderModule = {
  provider: 'azure-openai',
  models: MODELS,
  createDecoder: (model) => createOpenAiStyleDecoder(model, MODELS),
};
