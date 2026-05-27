// shared/protocol/ai/provider-routes.ts
/**
 * Per-provider wire shape: where to call, how to authenticate, how to build
 * the request body, and where to find the streaming response.
 *
 * The decode logic itself lives in the renderer's provider modules
 * (shared/protocol/ai/providers/*.ts) because each decoder is paired with a
 * fixture that exercises real provider output. The orchestrator here is
 * provider-agnostic — it just emits raw SSE bytes downstream.
 */

import type { Provider, ChatRequestSpec } from './types';

export interface ProviderRoute {
  buildRequest(spec: ChatRequestSpec, apiKey: string): {
    url: string;
    headers: Record<string, string>;
    body: string;
  };
}

const DEFAULT_BASE_URLS: Record<Provider, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  openrouter: 'https://openrouter.ai/api',
};

function baseUrl(spec: ChatRequestSpec): string {
  return spec.baseUrlOverride?.replace(/\/+$/, '') ?? DEFAULT_BASE_URLS[spec.provider];
}

/** OpenAI tools: [{ type:'function', function:{ name, description, parameters } }]. */
function openaiTools(spec: ChatRequestSpec) {
  if (!spec.tools || spec.tools.length === 0) return undefined;
  return spec.tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
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
        messages: spec.messages,
        stream: true,
        // Without this, OpenAI omits the usage block from the stream entirely.
        stream_options: { include_usage: true },
        max_tokens: spec.maxOutputTokens ?? 2048,
        ...(tools ? { tools } : {}),
      }),
    };
  },
};

const anthropicRoute: ProviderRoute = {
  buildRequest(spec, apiKey) {
    // Anthropic's /v1/messages takes system as a top-level field, not a role.
    const systemMessages = spec.messages.filter((m) => m.role === 'system');
    const turnMessages = spec.messages.filter((m) => m.role !== 'system');
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
        system: systemPrompt || undefined,
        messages: turnMessages,
        stream: true,
        max_tokens: spec.maxOutputTokens ?? 2048,
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
        'HTTP-Referer': 'https://restura.dev',  // OpenRouter attribution
        'X-Title': 'Restura',
      },
      body: JSON.stringify({
        model: spec.model,
        messages: spec.messages,
        stream: true,
        // OpenRouter is OpenAI-compatible; opt in to usage in the stream.
        stream_options: { include_usage: true },
        max_tokens: spec.maxOutputTokens ?? 2048,
        ...(openaiTools(spec) ? { tools: openaiTools(spec) } : {}),
      }),
    };
  },
};

export const PROVIDER_ROUTES: Record<Provider, ProviderRoute> = {
  openai: openaiRoute,
  anthropic: anthropicRoute,
  openrouter: openrouterRoute,
};
