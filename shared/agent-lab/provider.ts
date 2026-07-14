import type { ContentBlock, ModelRef } from './types';

export type Modality = 'text' | 'image' | 'audio' | 'document';

export interface ModelCapabilities {
  inputModalities: readonly Modality[];
  outputModalities: readonly Modality[];
  structuredOutput: boolean;
  toolCalling: boolean;
  parallelToolCalls: boolean;
  reasoning: boolean;
  continuation: boolean;
  serverTools: readonly string[];
  maxContextTokens?: number;
  maxOutputTokens?: number;
}

export interface DiscoveredAgentModel {
  id: string;
  label?: string;
  capabilities: ModelCapabilities;
  pricing?: { inputPerMTokUSD?: number; outputPerMTokUSD?: number };
}

export interface GenerationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ContentBlock[];
  toolCallId?: string;
  toolCalls?: AgentToolCall[];
  /** Opaque provider output needed for stateless/ZDR continuation. Never persisted as suite config. */
  providerState?: unknown;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface GenerationRequest {
  model: ModelRef;
  messages: GenerationMessage[];
  tools?: AgentToolDefinition[];
  structuredOutput?: Record<string, unknown>;
  reasoning?: { effort?: 'none' | 'low' | 'medium' | 'high'; summary?: boolean };
  continuationId?: string;
  maxOutputTokens?: number;
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface GenerationResponse {
  id: string;
  output: ContentBlock[];
  toolCalls: AgentToolCall[];
  continuationId?: string;
  usage?: { inputTokens: number; outputTokens: number };
  costUSD?: number;
  stopReason?: 'completed' | 'tool-calls' | 'max-tokens' | 'refusal';
  /** Opaque provider output items that must be replayed to continue without server-side storage. */
  providerState?: unknown;
}

export interface ProviderExecutionContext {
  signal?: AbortSignal;
  resolveCredential(ref: ModelRef['credential']): Promise<string | undefined>;
  onEvent?(event: { type: 'output.delta'; block: ContentBlock }): void;
}

export interface ProviderDiscoveryContext {
  signal?: AbortSignal;
  resolveCredential?(ref: ModelRef['credential']): Promise<string | undefined>;
}

export interface ProviderAdapter {
  readonly id: string;
  discoverModels(context?: ProviderDiscoveryContext): Promise<DiscoveredAgentModel[]>;
  getCapabilities(model: string): Promise<ModelCapabilities>;
  generate(
    request: GenerationRequest,
    context: ProviderExecutionContext
  ): Promise<GenerationResponse>;
}

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(adapters: ProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ProviderAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`duplicate provider adapter: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): ProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: string): ProviderAdapter {
    const adapter = this.get(id);
    if (!adapter) throw new Error(`unknown provider adapter: ${id}`);
    return adapter;
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }
}

function contentModality(block: ContentBlock): Modality | undefined {
  if (block.type === 'text' || block.type === 'reasoning-summary' || block.type === 'refusal') {
    return 'text';
  }
  if (block.type === 'image' || block.type === 'audio' || block.type === 'document') {
    return block.type;
  }
  return undefined;
}

export function validateGenerationRequest(
  request: GenerationRequest,
  capabilities: ModelCapabilities
): string[] {
  const errors: string[] = [];
  const seen = new Set<Modality>();
  for (const message of request.messages) {
    for (const block of message.content) {
      const modality = contentModality(block);
      if (!modality || seen.has(modality)) continue;
      seen.add(modality);
      if (!capabilities.inputModalities.includes(modality)) {
        errors.push(`model does not support ${modality} input`);
      }
    }
  }
  if (request.tools?.length && !capabilities.toolCalling) {
    errors.push('model does not support tool calling');
  }
  if (request.structuredOutput && !capabilities.structuredOutput) {
    errors.push('model does not support structured output');
  }
  if (request.reasoning && !capabilities.reasoning) {
    errors.push('model does not support reasoning controls');
  }
  if (request.continuationId && !capabilities.continuation) {
    errors.push('model does not support continuation');
  }
  return errors;
}
