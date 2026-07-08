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

import type { Provider, ChatRequestSpec } from './types';

export interface ProviderRoute {
  buildRequest(
    spec: ChatRequestSpec,
    apiKey: string
  ): {
    url: string;
    headers: Record<string, string>;
    body: string;
  };
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
};

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
        'HTTP-Referer': 'https://restura.dev', // OpenRouter attribution
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
          messages: spec.messages,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: spec.maxOutputTokens ?? 2048,
          ...(tools ? { tools } : {}),
        }),
      };
    },
  };
}

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
};
