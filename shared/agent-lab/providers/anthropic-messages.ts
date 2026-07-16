import type { Fetcher } from '../../protocol/types';
import type {
  DiscoveredAgentModel,
  GenerationMessage,
  GenerationRequest,
  GenerationResponse,
  ModelCapabilities,
  ProviderAdapter,
  ProviderDiscoveryContext,
  ProviderExecutionContext,
} from '../provider';
import type { ContentBlock, CredentialRef } from '../types';

const CAPABILITIES: ModelCapabilities = {
  inputModalities: ['text', 'image'],
  outputModalities: ['text'],
  structuredOutput: false,
  toolCalling: true,
  parallelToolCalls: true,
  reasoning: false,
  continuation: false,
  serverTools: [],
};

function contentText(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'text' || block.type === 'reasoning-summary') return block.text;
      if (block.type === 'json') return JSON.stringify(block.value);
      if (block.type === 'refusal') return block.reason;
      return `[${block.type}]`;
    })
    .join('\n');
}

function messageContent(message: GenerationMessage): Array<Record<string, unknown>> {
  if (message.role === 'tool') {
    return [
      {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: contentText(message.content),
      },
    ];
  }
  const blocks = message.content.flatMap((block): Array<Record<string, unknown>> => {
    if (block.type === 'text' || block.type === 'reasoning-summary') {
      return [{ type: 'text', text: block.text }];
    }
    if (block.type === 'json') return [{ type: 'text', text: JSON.stringify(block.value) }];
    if (block.type === 'refusal') return [{ type: 'text', text: block.reason }];
    if (block.type === 'image' && block.data) {
      return [
        { type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } },
      ];
    }
    return [{ type: 'text', text: `[${block.type}]` }];
  });
  if (message.role === 'assistant') {
    blocks.push(
      ...(message.toolCalls ?? []).map((tool) => ({
        type: 'tool_use',
        id: tool.id,
        name: tool.name,
        input: tool.arguments,
      }))
    );
  }
  return blocks;
}

function parseResponse(value: unknown): GenerationResponse {
  const response = value as {
    id?: unknown;
    content?: unknown;
    stop_reason?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  if (typeof response.id !== 'string' || !Array.isArray(response.content)) {
    throw new Error('Anthropic Messages returned an invalid response shape');
  }
  const output: ContentBlock[] = [];
  const toolCalls: GenerationResponse['toolCalls'] = [];
  for (const block of response.content as Array<Record<string, unknown>>) {
    if (block.type === 'text' && typeof block.text === 'string')
      output.push({ type: 'text', text: block.text });
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      output.push({ type: 'reasoning-summary', text: block.thinking });
    }
    if (
      block.type === 'tool_use' &&
      typeof block.id === 'string' &&
      typeof block.name === 'string'
    ) {
      toolCalls.push({ id: block.id, name: block.name, arguments: block.input ?? {} });
    }
  }
  const inputTokens = response.usage?.input_tokens;
  const outputTokens = response.usage?.output_tokens;
  return {
    id: response.id,
    output,
    toolCalls,
    ...(typeof inputTokens === 'number' && typeof outputTokens === 'number'
      ? { usage: { inputTokens, outputTokens } }
      : {}),
    stopReason:
      toolCalls.length > 0 || response.stop_reason === 'tool_use'
        ? 'tool-calls'
        : response.stop_reason === 'max_tokens'
          ? 'max-tokens'
          : 'completed',
  };
}

export interface AnthropicMessagesAdapterOptions {
  fetcher: Fetcher;
  discoveryCredential?: CredentialRef;
}

/** Native, stateless Anthropic Messages adapter for portable agent suites. */
export class AnthropicMessagesAdapter implements ProviderAdapter {
  readonly id = 'anthropic.messages';

  constructor(private readonly options: AnthropicMessagesAdapterOptions) {}

  async discoverModels(_context: ProviderDiscoveryContext = {}): Promise<DiscoveredAgentModel[]> {
    // Anthropic does not expose a public model-list endpoint suitable for this
    // adapter. Model IDs remain explicit portable suite configuration.
    return [];
  }

  async getCapabilities(_model: string): Promise<ModelCapabilities> {
    return CAPABILITIES;
  }

  async generate(
    request: GenerationRequest,
    context: ProviderExecutionContext
  ): Promise<GenerationResponse> {
    if (request.continuationId) throw new Error('Anthropic Messages has no server continuation');
    if (request.structuredOutput)
      throw new Error('Anthropic structured output is not enabled by this adapter');
    if (request.reasoning)
      throw new Error('Anthropic reasoning controls are not enabled by this adapter');
    const credential = await this.resolveCredential(request.model.credential, context);
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => contentText(message.content))
      .filter(Boolean)
      .join('\n\n');
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: messageContent(message),
      }));
    const response = await this.options.fetcher({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(credential ? { 'x-api-key': credential } : {}),
      },
      body: JSON.stringify({
        model: request.model.model,
        max_tokens: request.maxOutputTokens ?? 4096,
        ...(system ? { system } : {}),
        messages,
        ...(request.tools
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
              })),
            }
          : {}),
      }),
      signal: context.signal ?? new AbortController().signal,
    });
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Anthropic Messages ${response.status}: ${text.slice(0, 500)}`);
    }
    return parseResponse(JSON.parse(text));
  }

  private async resolveCredential(
    ref: CredentialRef | undefined,
    context: ProviderExecutionContext
  ): Promise<string | undefined> {
    if (!ref) return undefined;
    const credential = await context.resolveCredential(ref);
    if (!credential) throw new Error('Anthropic credential could not be resolved');
    return credential;
  }
}
