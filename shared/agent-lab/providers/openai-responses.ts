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

const OPENAI_RESPONSES_CAPABILITIES: ModelCapabilities = {
  inputModalities: ['text', 'image', 'document'],
  outputModalities: ['text'],
  structuredOutput: true,
  toolCalling: true,
  parallelToolCalls: true,
  reasoning: true,
  continuation: false,
  serverTools: [],
};

const UNKNOWN_OPENAI_MODEL_CAPABILITIES: ModelCapabilities = {
  inputModalities: ['text'],
  outputModalities: ['text'],
  structuredOutput: false,
  toolCalling: false,
  parallelToolCalls: false,
  reasoning: false,
  continuation: false,
  serverTools: [],
};

function capabilitiesForModel(model: string): ModelCapabilities {
  const excluded = /(embedding|image|audio|realtime|transcribe|tts|moderation|search|instruct)/i;
  const generationFamily = /^(gpt-(?:4o|4\.1|4\.5|5)(?:[.-]|$)|o[1345](?:-|$)|codex(?:-|$))/i;
  if (!generationFamily.test(model) || excluded.test(model)) {
    return UNKNOWN_OPENAI_MODEL_CAPABILITIES;
  }
  // Model catalogs do not expose reliable modality metadata. Keep reasoning
  // and Codex families text-only; standard GPT Responses families are known
  // here only for text/image/document. Audio stays disabled unless future
  // discovery metadata can prove support for the exact model.
  return /^(o[1345]|codex)(?:-|$)/i.test(model)
    ? { ...OPENAI_RESPONSES_CAPABILITIES, inputModalities: ['text'] }
    : OPENAI_RESPONSES_CAPABILITIES;
}

function inputContent(block: ContentBlock): Record<string, unknown> | undefined {
  switch (block.type) {
    case 'text':
      return { type: 'input_text', text: block.text };
    case 'image':
      return {
        type: 'input_image',
        image_url: block.uri ?? `data:${block.mimeType};base64,${block.data ?? ''}`,
      };
    case 'document':
      return block.uri
        ? { type: 'input_file', file_url: block.uri }
        : { type: 'input_file', filename: block.name ?? 'document', file_data: block.data };
    case 'audio': {
      if (!block.data) throw new Error('OpenAI Responses audio input requires base64 data');
      const format = {
        'audio/mpeg': 'mp3',
        'audio/mp3': 'mp3',
        'audio/wav': 'wav',
        'audio/x-wav': 'wav',
      }[block.mimeType.toLowerCase()];
      if (!format)
        throw new Error(`OpenAI Responses does not support audio MIME type ${block.mimeType}`);
      return { type: 'input_audio', input_audio: { data: block.data, format } };
    }
    case 'json':
      return { type: 'input_text', text: JSON.stringify(block.value) };
    case 'artifact':
      return { type: 'input_text', text: `[artifact:${block.artifactId}]` };
    case 'refusal':
      return { type: 'input_text', text: block.reason };
    case 'reasoning-summary':
      return { type: 'input_text', text: block.text };
  }
}

function inputItems(message: GenerationMessage): Record<string, unknown>[] {
  if (message.role === 'tool') {
    const output =
      message.content.length === 1 && message.content[0]?.type === 'json'
        ? JSON.stringify(message.content[0].value)
        : message.content
            .map((block) => {
              if (block.type === 'text' || block.type === 'reasoning-summary') return block.text;
              if (block.type === 'json') return JSON.stringify(block.value);
              return JSON.stringify(block);
            })
            .join('\n');
    return [{ type: 'function_call_output', call_id: message.toolCallId, output }];
  }
  if (message.role === 'assistant' && Array.isArray(message.providerState)) {
    return message.providerState as Record<string, unknown>[];
  }
  const content = message.content.map(inputContent).filter((v) => v !== undefined);
  const items: Record<string, unknown>[] = content.length ? [{ role: message.role, content }] : [];
  if (message.role === 'assistant') {
    items.push(
      ...(message.toolCalls ?? []).map((call) => ({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments:
          typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
      }))
    );
  }
  return items;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseResponse(value: unknown): GenerationResponse {
  const body = value as {
    id?: unknown;
    output?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
    status?: unknown;
  };
  if (typeof body.id !== 'string' || !Array.isArray(body.output)) {
    throw new Error('OpenAI Responses returned an invalid response shape');
  }
  const output: ContentBlock[] = [];
  const toolCalls: GenerationResponse['toolCalls'] = [];
  for (const item of body.output as Array<Record<string, unknown>>) {
    if (item.type === 'reasoning' && Array.isArray(item.summary)) {
      for (const summary of item.summary as Array<Record<string, unknown>>) {
        if (summary.type === 'summary_text' && typeof summary.text === 'string') {
          output.push({ type: 'reasoning-summary', text: summary.text });
        }
      }
    }
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const content of item.content as Array<Record<string, unknown>>) {
        if (content.type === 'output_text' && typeof content.text === 'string') {
          output.push({ type: 'text', text: content.text });
        } else if (content.type === 'refusal' && typeof content.refusal === 'string') {
          output.push({ type: 'refusal', reason: content.refusal });
        }
      }
    }
    if (item.type === 'function_call' && typeof item.name === 'string') {
      const id =
        typeof item.call_id === 'string'
          ? item.call_id
          : typeof item.id === 'string'
            ? item.id
            : crypto.randomUUID();
      toolCalls.push({ id, name: item.name, arguments: parseArguments(item.arguments) });
    }
  }
  const inputTokens = body.usage?.input_tokens;
  const outputTokens = body.usage?.output_tokens;
  const hasUsage = typeof inputTokens === 'number' && typeof outputTokens === 'number';
  return {
    id: body.id,
    output,
    toolCalls,
    continuationId: body.id,
    ...(hasUsage ? { usage: { inputTokens, outputTokens } } : {}),
    stopReason:
      toolCalls.length > 0
        ? 'tool-calls'
        : body.status === 'incomplete'
          ? 'max-tokens'
          : 'completed',
    providerState: body.output,
  };
}

export interface OpenAiResponsesAdapterOptions {
  fetcher: Fetcher;
  baseUrl?: string;
  discoveryCredential?: CredentialRef;
}

export class OpenAiResponsesAdapter implements ProviderAdapter {
  readonly id = 'openai.responses';
  private readonly fetcher: Fetcher;
  private readonly baseUrl: string;
  private readonly discoveryCredential: CredentialRef | undefined;

  constructor(options: OpenAiResponsesAdapterOptions) {
    this.fetcher = options.fetcher;
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com').replace(/\/+$/, '');
    this.discoveryCredential = options.discoveryCredential;
  }

  async discoverModels(context: ProviderDiscoveryContext = {}): Promise<DiscoveredAgentModel[]> {
    const credential = this.discoveryCredential
      ? await context.resolveCredential?.(this.discoveryCredential)
      : undefined;
    if (this.discoveryCredential && !credential) {
      throw new Error('OpenAI discovery credential could not be resolved');
    }
    const response = await this.fetcher({
      url: `${this.baseUrl}/v1/models`,
      method: 'GET',
      headers: credential ? { Authorization: `Bearer ${credential}` } : {},
      body: undefined,
      signal: context.signal ?? new AbortController().signal,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OpenAI model discovery failed with status ${response.status}`);
    }
    const body = JSON.parse(await response.text()) as { data?: Array<{ id?: unknown }> };
    return (body.data ?? [])
      .filter((model): model is { id: string } => typeof model.id === 'string')
      .map((model) => ({ id: model.id, capabilities: capabilitiesForModel(model.id) }));
  }

  async getCapabilities(model: string): Promise<ModelCapabilities> {
    return capabilitiesForModel(model);
  }

  async generate(
    request: GenerationRequest,
    context: ProviderExecutionContext
  ): Promise<GenerationResponse> {
    if (request.continuationId) {
      throw new Error('OpenAI Responses continuation IDs are disabled with store:false');
    }
    const credential = await this.resolveCredential(request.model.credential, context);
    const body = {
      model: request.model.model,
      input: request.messages.flatMap(inputItems),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            })),
          }
        : {}),
      ...(request.structuredOutput
        ? {
            text: {
              format: { type: 'json_schema', name: 'response', schema: request.structuredOutput },
            },
          }
        : {}),
      ...(request.reasoning
        ? {
            reasoning: {
              ...(request.reasoning.effort ? { effort: request.reasoning.effort } : {}),
              ...(request.reasoning.summary ? { summary: 'auto' } : {}),
            },
          }
        : {}),
      ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
      include: ['reasoning.encrypted_content'],
      store: false,
    };
    const response = await this.fetcher({
      url: `${request.model.baseUrl?.replace(/\/+$/, '') ?? this.baseUrl}/v1/responses`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      },
      body: JSON.stringify(body),
      signal: context.signal ?? new AbortController().signal,
    });
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OpenAI Responses ${response.status}: ${text.slice(0, 500)}`);
    }
    return parseResponse(JSON.parse(text));
  }

  private async resolveCredential(
    ref: CredentialRef | undefined,
    context: ProviderExecutionContext
  ): Promise<string | undefined> {
    if (!ref) return undefined;
    const credential = await context.resolveCredential(ref);
    if (!credential) throw new Error('OpenAI credential could not be resolved');
    return credential;
  }
}
