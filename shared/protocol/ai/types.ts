// shared/protocol/ai/types.ts
/**
 * Wire types for the AI chat subsystem. Lives in shared/protocol/ to match the
 * other protocol cores (http, grpc, mcp, sse). The Electron handler is the
 * only consumer today; keeping the shape here leaves the door open to a
 * future Worker handler without a refactor.
 */

/**
 * Cloud providers with first-class, hardcoded-safe endpoints and known pricing.
 * The existing AI chat panel only ever talks to these.
 */
export type CloudProvider = 'openai' | 'anthropic' | 'openrouter';

/**
 * Local / self-hosted runtimes that speak the OpenAI wire format at a
 * user-supplied base URL. `ollama` defaults to http://localhost:11434;
 * `openai-compatible` covers LM Studio, vLLM, llama.cpp, Together, Groq, etc.
 * These are Electron-only (the AI Lab) and drive the localhost SSRF carve-out —
 * see electron/main/handlers/ai-lab-handler.ts.
 */
export type LocalProvider = 'ollama' | 'openai-compatible';

export type Provider = CloudProvider | LocalProvider;

/** True for providers that may legitimately target localhost / private hosts. */
export function isLocalProvider(provider: Provider): provider is LocalProvider {
  return provider === 'ollama' || provider === 'openai-compatible';
}

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessageWire {
  role: ChatRole;
  content: string;
}

/**
 * A tool the model may call. `inputSchema` is a JSON Schema object describing
 * the tool's arguments. The renderer supplies these (see src/features/ai/agent)
 * and executes the call after user confirmation; the wire layer just forwards
 * the definitions to the provider and decodes any resulting tool calls.
 */
export interface AiToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatRequestSpec {
  provider: Provider;
  model: string; // e.g. "claude-sonnet-4-x"
  messages: ChatMessageWire[]; // system first, then alternating user/assistant
  apiKeyHandleId: string; // resolved by secretResolver in the handler
  baseUrlOverride?: string; // user-set self-hosted / regional endpoint
  rawMode: boolean; // toggles the backend paranoia pass
  maxOutputTokens?: number; // default per provider in provider-routes
  tools?: AiToolDef[]; // agentic tool definitions (optional)
  signal?: AbortSignal; // wired from the handler's AbortController
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  estimatedCostUSD: number;
}

export type ChatErrorCode = 'provider' | 'network' | 'parse' | 'aborted' | 'guard';

export type ChatStreamEvent =
  | { type: 'delta'; text: string }
  // A complete tool call decoded from the provider stream. `input` is the raw
  // JSON-string of arguments (parsed + validated by the agent layer before use).
  | { type: 'tool_call'; id: string; name: string; input: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; code: ChatErrorCode; message: string }
  | { type: 'done' };

export interface ChatToolCall {
  id: string;
  name: string;
  /** Raw JSON-string of arguments. */
  input: string;
}

/**
 * Result of draining {@link ChatStreamEvent}s to completion — the shape the
 * eval runner and LLM-as-judge consume. No per-token streaming; one object per
 * model call. See shared/protocol/ai/ai-complete.ts.
 */
export interface CompletionResult {
  ok: boolean;
  text: string;
  usage?: Usage;
  toolCalls: ChatToolCall[];
  error?: { code: ChatErrorCode; message: string };
}
