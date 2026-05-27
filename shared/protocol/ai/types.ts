// shared/protocol/ai/types.ts
/**
 * Wire types for the AI chat subsystem. Lives in shared/protocol/ to match the
 * other protocol cores (http, grpc, mcp, sse). The Electron handler is the
 * only consumer today; keeping the shape here leaves the door open to a
 * future Worker handler without a refactor.
 */

export type Provider = 'openai' | 'anthropic' | 'openrouter';

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
  model: string;                          // e.g. "claude-sonnet-4-x"
  messages: ChatMessageWire[];            // system first, then alternating user/assistant
  apiKeyHandleId: string;                 // resolved by secretResolver in the handler
  baseUrlOverride?: string;               // user-set self-hosted / regional endpoint
  rawMode: boolean;                       // toggles the backend paranoia pass
  maxOutputTokens?: number;               // default per provider in provider-routes
  tools?: AiToolDef[];                    // agentic tool definitions (optional)
  signal?: AbortSignal;                   // wired from the handler's AbortController
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  estimatedCostUSD: number;
}

export type ChatStreamEvent =
  | { type: 'delta'; text: string }
  // A complete tool call decoded from the provider stream. `input` is the raw
  // JSON-string of arguments (parsed + validated by the agent layer before use).
  | { type: 'tool_call'; id: string; name: string; input: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; code: 'provider' | 'network' | 'parse' | 'aborted' | 'guard'; message: string }
  | { type: 'done' };
