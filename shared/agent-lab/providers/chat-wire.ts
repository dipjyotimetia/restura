// Agent generation over the shared AI chat wire (shared/protocol/ai): the same
// provider routes, decoders, SigV4 signing and redaction guard the desktop AI
// Lab uses, so a provider shipped there runs identically headless. Desktop
// keeps its IPC transport; the CLI calls `runToCompletion` with its own
// fetcher via ChatWireProviderAdapter.
import { runToCompletion } from '../../protocol/ai/ai-complete';
import type { AwsRequestSigner } from '../../protocol/ai/provider-routes';
import type {
  ChatMessageWire,
  CompletionResult,
  EnterpriseProvider,
} from '../../protocol/ai/types';
import type { Fetcher } from '../../protocol/types';
import type {
  DiscoveredAgentModel,
  GenerationMessage,
  GenerationRequest,
  GenerationResponse,
  ModelCapabilities,
  ProviderAdapter,
  ProviderExecutionContext,
} from '../provider';
import { STANDARD_PROVIDER_PROFILES } from './callback';
import { type AgentModelPriceOverrides, knownCostUSD, resolveModelPrice } from './pricing';

/** Flatten agent content blocks into the text-only chat wire messages. */
export function generationMessagesToWire(messages: GenerationMessage[]): ChatMessageWire[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content
      .map((block) => {
        if (block.type === 'text' || block.type === 'reasoning-summary') return block.text;
        if (block.type === 'json') return JSON.stringify(block.value);
        if (block.type === 'refusal') return block.reason;
        return `[${block.type}]`;
      })
      .join('\n'),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            input:
              typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
          })),
        }
      : {}),
  }));
}

/** Map a drained chat completion onto the agent runner's response shape. */
export function completionToGenerationResponse(
  completion: CompletionResult,
  costUSD: number | undefined
): GenerationResponse {
  if (!completion.ok) throw new Error(completion.error?.message ?? 'model call failed');
  return {
    id: crypto.randomUUID(),
    output: completion.text ? [{ type: 'text', text: completion.text }] : [],
    toolCalls: completion.toolCalls.map((call) => {
      let arguments_: unknown = call.input;
      try {
        arguments_ = JSON.parse(call.input);
      } catch {
        /* preserve invalid provider payload */
      }
      return { id: call.id, name: call.name, arguments: arguments_ };
    }),
    ...(completion.usage
      ? {
          usage: {
            inputTokens: completion.usage.promptTokens,
            outputTokens: completion.usage.completionTokens,
          },
          ...(costUSD !== undefined ? { costUSD } : {}),
        }
      : {}),
    stopReason: completion.toolCalls.length ? 'tool-calls' : 'completed',
  };
}

/** Suite provider ids (STANDARD_PROVIDER_PROFILES) → shared chat-wire provider. */
export const CHAT_WIRE_PROVIDERS = {
  'azure.openai': 'azure-openai',
  'google.generateContent': 'gemini',
  'aws.bedrock.converse': 'bedrock',
} as const satisfies Record<string, EnterpriseProvider>;

export type ChatWireProviderId = keyof typeof CHAT_WIRE_PROVIDERS;

export function isChatWireProviderId(id: string): id is ChatWireProviderId {
  return Object.hasOwn(CHAT_WIRE_PROVIDERS, id);
}

export interface ChatWireProviderAdapterOptions {
  id: ChatWireProviderId;
  fetcher: Fetcher;
  /** Operator-supplied endpoint (Azure resource, Bedrock region). Never from the suite. */
  baseUrl?: string;
  priceOverrides?: AgentModelPriceOverrides;
  awsSigner?: AwsRequestSigner;
  /** Skip the outgoing secret check (the desktop "send unredacted to cloud" override). */
  sendUnredacted?: boolean;
}

// The runner hands the resolved credential to runToCompletion through a
// one-call resolver, so the key never sits in the spec.
const CREDENTIAL_HANDLE = 'agent-credential';

export class ChatWireProviderAdapter implements ProviderAdapter {
  readonly id: ChatWireProviderId;

  constructor(private readonly options: ChatWireProviderAdapterOptions) {
    this.id = options.id;
  }

  async discoverModels(): Promise<DiscoveredAgentModel[]> {
    return [];
  }

  async getCapabilities(): Promise<ModelCapabilities> {
    return STANDARD_PROVIDER_PROFILES[this.id];
  }

  async generate(
    request: GenerationRequest,
    context: ProviderExecutionContext
  ): Promise<GenerationResponse> {
    const credential = await context.resolveCredential(request.model.credential);
    if (!credential) {
      throw new Error(`${this.id} needs a credential (model.credential with source "env")`);
    }
    const provider = CHAT_WIRE_PROVIDERS[this.id];
    const completion = await runToCompletion(
      {
        provider,
        model: request.model.model,
        messages: generationMessagesToWire(request.messages),
        apiKeyHandleId: CREDENTIAL_HANDLE,
        rawMode: this.options.sendUnredacted === true,
        ...(this.options.baseUrl ? { baseUrlOverride: this.options.baseUrl } : {}),
        ...(request.maxOutputTokens !== undefined
          ? { maxOutputTokens: request.maxOutputTokens }
          : {}),
        ...(request.tools ? { tools: request.tools } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      },
      this.options.fetcher,
      async (handle) => (handle === CREDENTIAL_HANDLE ? credential : undefined),
      this.options.awsSigner ? { awsSigner: this.options.awsSigner } : {}
    );
    const usage = completion.usage;
    const costUSD = usage
      ? knownCostUSD(resolveModelPrice(this.id, request.model.model, this.options.priceOverrides), {
          input: usage.promptTokens - (usage.cacheReadTokens ?? 0) - (usage.cacheWriteTokens ?? 0),
          cacheRead: usage.cacheReadTokens ?? 0,
          cacheWrite: usage.cacheWriteTokens ?? 0,
          output: usage.completionTokens,
        })
      : undefined;
    return completionToGenerationResponse(completion, costUSD);
  }
}
