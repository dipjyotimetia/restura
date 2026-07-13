import type {
  DiscoveredAgentModel,
  GenerationRequest,
  GenerationResponse,
  ModelCapabilities,
  ProviderAdapter,
  ProviderDiscoveryContext,
  ProviderExecutionContext,
} from '../provider';

const textTools: ModelCapabilities = {
  inputModalities: ['text'],
  outputModalities: ['text'],
  structuredOutput: false,
  toolCalling: true,
  parallelToolCalls: true,
  reasoning: false,
  continuation: false,
  serverTools: [],
};

export const STANDARD_PROVIDER_PROFILES = {
  'openai.responses': {
    ...textTools,
    inputModalities: ['text', 'image', 'audio', 'document'],
    outputModalities: ['text'],
    structuredOutput: true,
    reasoning: true,
    continuation: false,
    serverTools: [],
  },
  'openai.chat': { ...textTools },
  'anthropic.messages': { ...textTools },
  'google.generateContent': { ...textTools },
  'azure.openai': { ...textTools },
  'aws.bedrock.converse': { ...textTools },
  openrouter: { ...textTools },
  ollama: { ...textTools },
  huggingface: { ...textTools, toolCalling: false, parallelToolCalls: false },
  'openai.compatible': { ...textTools },
} satisfies Record<string, ModelCapabilities>;

export interface CallbackProviderAdapterOptions {
  id: string;
  capabilities: ModelCapabilities | ((model: string) => Promise<ModelCapabilities>);
  generate(
    request: GenerationRequest,
    context: ProviderExecutionContext
  ): Promise<GenerationResponse>;
  discoverModels?(context?: ProviderDiscoveryContext): Promise<DiscoveredAgentModel[]>;
}

/**
 * Transport-neutral adapter used by Electron IPC, Node CI, gateways and plugins.
 * Provider ids remain data, so supporting a new model endpoint does not require
 * changing the suite schema or runner.
 */
export class CallbackProviderAdapter implements ProviderAdapter {
  readonly id: string;

  constructor(private readonly options: CallbackProviderAdapterOptions) {
    this.id = options.id;
  }

  async discoverModels(context?: ProviderDiscoveryContext): Promise<DiscoveredAgentModel[]> {
    return this.options.discoverModels?.(context) ?? [];
  }

  async getCapabilities(model: string): Promise<ModelCapabilities> {
    return typeof this.options.capabilities === 'function'
      ? this.options.capabilities(model)
      : this.options.capabilities;
  }

  generate(
    request: GenerationRequest,
    context: ProviderExecutionContext
  ): Promise<GenerationResponse> {
    return this.options.generate(request, context);
  }
}
