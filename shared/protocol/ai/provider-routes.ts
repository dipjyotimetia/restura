// shared/protocol/ai/provider-routes.ts
/**
 * Per-provider wire shape: where to call, how to authenticate, how to build
 * the request body, and where to find the streaming response.
 *
 * The decode logic itself lives in the per-provider modules
 * (shared/protocol/ai/providers/*.ts) because each decoder is paired with a
 * fixture that exercises real provider output. The orchestrator (ai-proxy.ts)
 * is provider-agnostic — it just emits raw SSE bytes downstream.
 */

import { signSigV4 } from '../auth-signer';
import { bedrockRegionFromUrl, parseBedrockIamCredentials } from './providers/bedrock';
import type { ChatRequestSpec, Provider } from './types';

export interface BuiltProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Signs an AWS request. Desktop injects the `@smithy/signature-v4` signer from
 * Electron main; elsewhere the built-in Web Crypto signer is used.
 */
export type AwsRequestSigner = (
  request: { method: string; url: string; headers: Record<string, string>; body: string },
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    region: string;
    service: string;
  }
) => Promise<Record<string, string>>;

export interface ProviderRouteContext {
  awsSigner?: AwsRequestSigner;
}

export interface ProviderRoute {
  buildRequest(spec: ChatRequestSpec, apiKey: string): BuiltProviderRequest;
  /** Request-time auth that hashes the final bytes (SigV4). Runs after buildRequest. */
  sign?(
    request: BuiltProviderRequest,
    apiKey: string,
    context: ProviderRouteContext
  ): Promise<BuiltProviderRequest>;
  /** `json`: the provider answers with one JSON body, fed to the decoder whole. Default `sse`. */
  responseMode?: 'sse' | 'json';
}

const DEFAULT_BASE_URLS: Record<Provider, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  openrouter: 'https://openrouter.ai/api',
  ollama: 'http://localhost:11434',
  // HuggingFace Inference Providers router — OpenAI-compatible cloud gateway.
  // The user's HF token (hf_…) is sent as a Bearer header; like the other
  // cloud providers, localhost/private-host overrides are refused (the SSRF
  // carve-out is gated by isLocalProvider, which is false for huggingface).
  huggingface: 'https://router.huggingface.co',
  // No sensible default — the user must supply a base URL for a generic
  // OpenAI-compatible endpoint (enforced by the AI Lab provider form).
  'openai-compatible': '',
  // Per-customer resource endpoint (https://{resource}.openai.azure.com); required.
  'azure-openai': '',
  gemini: 'https://generativelanguage.googleapis.com',
  // The region lives in the host; pick another region by overriding the base URL.
  bedrock: 'https://bedrock-runtime.us-east-1.amazonaws.com',
};

// Output caps are a backstop, not a tuning knob: a tight cap truncates mid-answer
// without making the model any more economical. Current models also spend the
// cap on reasoning (Opus 5.5 always thinks; OpenAI GPT-5+/6 reason by default),
// so 2048 could leave no room for the visible reply.
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const OPENAI_DEFAULT_MAX_COMPLETION_TOKENS = 16384;

function baseUrl(spec: ChatRequestSpec): string {
  return spec.baseUrlOverride?.replace(/\/+$/, '') ?? DEFAULT_BASE_URLS[spec.provider];
}

/**
 * The effective base URL for a provider call — the override, or the provider's
 * default. Exported so the Electron handler can resolve + DNS-pin the exact host
 * it's about to connect to (the SSRF guard validates this same host).
 */
export function resolveBaseUrl(provider: Provider, baseUrlOverride?: string): string {
  return baseUrlOverride?.replace(/\/+$/, '') ?? DEFAULT_BASE_URLS[provider];
}

/** OpenAI tools: [{ type:'function', function:{ name, description, parameters } }]. */
function openaiTools(spec: ChatRequestSpec) {
  if (!spec.tools || spec.tools.length === 0) return undefined;
  return spec.tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

function parseToolInput(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function openaiMessages(spec: ChatRequestSpec) {
  return spec.messages.map((message) => {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.input },
        })),
      };
    }
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    }
    return { role: message.role, content: message.content };
  });
}

function anthropicMessages(spec: ChatRequestSpec) {
  return spec.messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      if (message.role === 'assistant' && message.toolCalls?.length) {
        return {
          role: 'assistant',
          content: [
            ...(message.content ? [{ type: 'text', text: message.content }] : []),
            ...message.toolCalls.map((call) => ({
              type: 'tool_use',
              id: call.id,
              name: call.name,
              input: parseToolInput(call.input),
            })),
          ],
        };
      }
      if (message.role === 'tool') {
        return {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content },
          ],
        };
      }
      return { role: message.role, content: message.content };
    });
}

const openaiRoute: ProviderRoute = {
  buildRequest(spec, apiKey) {
    const tools = openaiTools(spec);
    return {
      url: `${baseUrl(spec)}/v1/chat/completions`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: spec.model,
        messages: openaiMessages(spec),
        stream: true,
        // Without this, OpenAI omits the usage block from the stream entirely.
        stream_options: { include_usage: true },
        // GPT-5+ / GPT-6 reject the legacy `max_tokens` on Chat Completions.
        max_completion_tokens: spec.maxOutputTokens ?? OPENAI_DEFAULT_MAX_COMPLETION_TOKENS,
        ...(tools ? { tools } : {}),
      }),
    };
  },
};

const anthropicRoute: ProviderRoute = {
  buildRequest(spec, apiKey) {
    // Anthropic's /v1/messages takes system as a top-level field, not a role.
    const systemMessages = spec.messages.filter((m) => m.role === 'system');
    const turnMessages = anthropicMessages(spec);
    const systemPrompt = systemMessages.map((m) => m.content).join('\n\n');
    return {
      url: `${baseUrl(spec)}/v1/messages`,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: spec.model,
        // The system prompt and tools are byte-stable across turns, so an explicit
        // breakpoint on the system block caches that prefix (and lets independent
        // conversations share it); the top-level marker auto-caches the growing tail.
        // Prefixes under the model's minimum cacheable length silently skip caching.
        cache_control: { type: 'ephemeral' },
        system: systemPrompt
          ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
          : undefined,
        messages: turnMessages,
        stream: true,
        max_tokens: spec.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        // Anthropic tools: [{ name, description, input_schema }].
        ...(spec.tools && spec.tools.length > 0
          ? {
              tools: spec.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema,
              })),
            }
          : {}),
      }),
    };
  },
};

const openrouterRoute: ProviderRoute = {
  // OpenAI-compatible API at a different base URL; identical request shape.
  buildRequest(spec, apiKey) {
    return {
      url: `${baseUrl(spec)}/v1/chat/completions`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://restura.dev', // OpenRouter attribution
        'X-Title': 'Restura',
      },
      body: JSON.stringify({
        model: spec.model,
        messages: openaiMessages(spec),
        stream: true,
        // OpenRouter is OpenAI-compatible; opt in to usage in the stream.
        stream_options: { include_usage: true },
        max_tokens: spec.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        ...(openaiTools(spec) ? { tools: openaiTools(spec) } : {}),
      }),
    };
  },
};

/**
 * Ollama + generic OpenAI-compatible endpoints. Identical OpenAI wire shape;
 * the only differences from `openaiRoute` are (1) auth is optional — a bare
 * local Ollama needs no key, so the Authorization header is sent only when a
 * key is present — and (2) the base URL is user-supplied. SSRF/localhost policy
 * is enforced upstream in the AI-Lab handler, not here.
 */
function openAiCompatibleRoute(): ProviderRoute {
  return {
    buildRequest(spec, apiKey) {
      const tools = openaiTools(spec);
      return {
        url: `${baseUrl(spec)}/v1/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: spec.model,
          messages: openaiMessages(spec),
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: spec.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          ...(tools ? { tools } : {}),
        }),
      };
    },
  };
}

/** Azure OpenAI v1 API: OpenAI Chat Completions with an `api-key` header; `model` is the deployment. */
const azureOpenAiRoute: ProviderRoute = {
  buildRequest(spec, apiKey) {
    const tools = openaiTools(spec);
    return {
      url: `${baseUrl(spec)}/openai/v1/chat/completions`,
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        model: spec.model,
        messages: openaiMessages(spec),
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: spec.maxOutputTokens ?? OPENAI_DEFAULT_MAX_COMPLETION_TOKENS,
        ...(tools ? { tools } : {}),
      }),
    };
  },
};

/** Map each tool call id to its function name (Gemini answers tool results by name). */
function toolNamesById(spec: ChatRequestSpec): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of spec.messages) {
    for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
  }
  return names;
}

/** Providers that reject consecutive same-role turns: merge them into one. */
function mergeConsecutive<T extends { role: string; parts?: unknown[]; content?: unknown[] }>(
  turns: T[],
  key: 'parts' | 'content'
): T[] {
  const merged: T[] = [];
  for (const turn of turns) {
    const previous = merged[merged.length - 1];
    if (previous && previous.role === turn.role) {
      (previous[key] as unknown[]).push(...((turn[key] as unknown[]) ?? []));
    } else {
      merged.push({ ...turn, [key]: [...((turn[key] as unknown[]) ?? [])] });
    }
  }
  return merged;
}

function geminiContents(spec: ChatRequestSpec) {
  const names = toolNamesById(spec);
  const turns = spec.messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      if (message.role === 'tool') {
        return {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: names.get(message.toolCallId ?? '') ?? message.toolCallId ?? 'tool',
                response: { content: message.content },
              },
            },
          ],
        };
      }
      if (message.role === 'assistant') {
        return {
          role: 'model',
          parts: [
            ...(message.content ? [{ text: message.content }] : []),
            ...(message.toolCalls ?? []).map((call) => ({
              functionCall: { name: call.name, args: parseToolInput(call.input) },
            })),
          ],
        };
      }
      return { role: 'user', parts: [{ text: message.content }] };
    });
  return mergeConsecutive(turns, 'parts');
}

/** Gemini API generateContent, streamed as SSE; key in `x-goog-api-key` (never the URL). */
const geminiRoute: ProviderRoute = {
  buildRequest(spec, apiKey) {
    const system = spec.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    return {
      url: `${baseUrl(spec)}/v1beta/models/${encodeURIComponent(spec.model)}:streamGenerateContent?alt=sse`,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: geminiContents(spec),
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: { maxOutputTokens: spec.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS },
        ...(spec.tools && spec.tools.length > 0
          ? {
              tools: [
                {
                  functionDeclarations: spec.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    // Full JSON Schema; `parameters` only takes the OpenAPI subset.
                    parametersJsonSchema: tool.inputSchema,
                  })),
                },
              ],
            }
          : {}),
      }),
    };
  },
};

function bedrockMessages(spec: ChatRequestSpec) {
  const turns = spec.messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      if (message.role === 'tool') {
        return {
          role: 'user',
          content: [
            {
              toolResult: {
                toolUseId: message.toolCallId,
                content: [{ text: message.content }],
              },
            },
          ],
        };
      }
      if (message.role === 'assistant') {
        return {
          role: 'assistant',
          content: [
            ...(message.content ? [{ text: message.content }] : []),
            ...(message.toolCalls ?? []).map((call) => ({
              toolUse: { toolUseId: call.id, name: call.name, input: parseToolInput(call.input) },
            })),
          ],
        };
      }
      return { role: 'user', content: [{ text: message.content }] };
    });
  return mergeConsecutive(turns, 'content');
}

/**
 * Amazon Bedrock Converse. The secret is either a Bedrock API key (Bearer) or
 * IAM credentials as JSON, which `sign` turns into a SigV4 signature over the
 * final body bytes.
 */
const bedrockRoute: ProviderRoute = {
  responseMode: 'json',
  buildRequest(spec, apiKey) {
    const system = spec.messages
      .filter((message) => message.role === 'system')
      .map((message) => ({ text: message.content }));
    const iam = parseBedrockIamCredentials(apiKey);
    return {
      url: `${baseUrl(spec)}/model/${encodeURIComponent(spec.model)}/converse`,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(iam ? {} : { Authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({
        messages: bedrockMessages(spec),
        ...(system.length > 0 ? { system } : {}),
        inferenceConfig: { maxTokens: spec.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS },
        ...(spec.tools && spec.tools.length > 0
          ? {
              toolConfig: {
                tools: spec.tools.map((tool) => ({
                  toolSpec: {
                    name: tool.name,
                    description: tool.description,
                    inputSchema: { json: tool.inputSchema },
                  },
                })),
              },
            }
          : {}),
      }),
    };
  },
  async sign(request, apiKey, context) {
    const iam = parseBedrockIamCredentials(apiKey);
    if (!iam) return request;
    const region = bedrockRegionFromUrl(request.url);
    if (!region) {
      throw new Error(
        'Bedrock IAM signing needs a bedrock-runtime.{region}.amazonaws.com base URL'
      );
    }
    const signer = context.awsSigner ?? builtInAwsSigner;
    const signed = await signer(
      { method: 'POST', url: request.url, headers: request.headers, body: request.body },
      { ...iam, region, service: 'bedrock' }
    );
    return { ...request, headers: { ...request.headers, ...signed } };
  },
};

const builtInAwsSigner: AwsRequestSigner = (request, credentials) =>
  signSigV4(
    { method: request.method, url: request.url, headers: request.headers, body: request.body },
    {
      accessKey: credentials.accessKeyId,
      secretKey: credentials.secretAccessKey,
      region: credentials.region,
      service: credentials.service,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
      // Non-S3 services canonicalise the already-encoded path again (model ids carry ':').
      doubleEncodePath: true,
    }
  );

export const PROVIDER_ROUTES: Record<Provider, ProviderRoute> = {
  openai: openaiRoute,
  anthropic: anthropicRoute,
  openrouter: openrouterRoute,
  ollama: openAiCompatibleRoute(),
  // HuggingFace's router speaks the OpenAI Chat Completions wire format at
  // ${baseUrl}/v1/chat/completions; auth is a Bearer HF token. Reuses the
  // openai-compatible route builder (Bearer-when-key-present) so a misconfigured
  // keyless call fails with the provider's own 401 rather than a synthetic error.
  huggingface: openAiCompatibleRoute(),
  'openai-compatible': openAiCompatibleRoute(),
  'azure-openai': azureOpenAiRoute,
  gemini: geminiRoute,
  bedrock: bedrockRoute,
};
