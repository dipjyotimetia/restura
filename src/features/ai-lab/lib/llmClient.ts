// Renderer → IPC bridge for AI Lab model calls. Wraps window.electron.aiLab so
// the rest of the feature (runner, scorers, Playground) never touches the raw
// bridge. Electron-only — throws a clear error on web.
import type { ChatStreamEvent, CompletionResult, Provider } from '@shared/protocol/ai/types';
import type { AiLabProviderConfig } from '../types';
import { getElectronAPI } from '@/lib/shared/platform';

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; input: string }>;
}

export interface LlmCallSpec {
  provider: Provider;
  model: string;
  messages: LlmChatMessage[];
  apiKeyHandleId?: string;
  baseUrlOverride?: string;
  rawMode?: boolean;
  maxOutputTokens?: number;
  tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

function api() {
  const a = getElectronAPI()?.aiLab;
  if (!a) throw new Error('AI Lab is only available in the desktop app.');
  return a;
}

/** Build a call spec from a stored provider config + model id. */
export function specFor(
  cfg: AiLabProviderConfig,
  model: string,
  messages: LlmChatMessage[],
  opts: { maxOutputTokens?: number; tools?: LlmCallSpec['tools'] } = {}
): LlmCallSpec {
  return {
    provider: cfg.provider,
    model,
    messages,
    // AI Lab prompts are user-authored test inputs (no auto-captured request
    // context), so the redaction paranoia pass is off — otherwise a prompt that
    // legitimately mentions a token would be refused.
    rawMode: true,
    ...(cfg.apiKeyHandleId ? { apiKeyHandleId: cfg.apiKeyHandleId } : {}),
    ...(cfg.baseUrl ? { baseUrlOverride: cfg.baseUrl } : {}),
    ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
  };
}

/** Non-streaming completion (eval cells + LLM-as-judge). */
export async function completeLlm(
  spec: LlmCallSpec,
  options: { signal?: AbortSignal; operationId?: string } = {}
): Promise<CompletionResult> {
  const operationId = options.operationId ?? crypto.randomUUID();
  const a = api();
  const cancel = () => void a.cancelComplete({ operationId });
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    options.signal?.throwIfAborted();
    const res = await a.complete({
      ...spec,
      operationId,
      rawMode: spec.rawMode ?? true,
    });
    options.signal?.throwIfAborted();
    if (!res.ok) throw new Error(res.error);
    return res.result;
  } finally {
    options.signal?.removeEventListener('abort', cancel);
  }
}

export interface StreamHandle {
  streamId: string;
  cancel: () => void;
}

/**
 * Start a streaming completion (Playground). Subscribes to chunk/end channels
 * BEFORE invoking `stream` so no early events are missed, mirroring the chat
 * streamConsumer contract.
 */
export async function streamLlm(
  spec: LlmCallSpec,
  handlers: {
    onChunk: (ev: ChatStreamEvent) => void;
    onEnd: (reason: 'done' | 'cancelled' | 'error') => void;
  }
): Promise<StreamHandle> {
  const a = api();
  const streamId = crypto.randomUUID();
  const offChunk = a.onChunk(streamId, handlers.onChunk);
  const offEnd = a.onEnd(streamId, (p) => {
    handlers.onEnd(p.reason);
    offChunk();
    offEnd();
  });
  const res = await a.stream({ ...spec, rawMode: spec.rawMode ?? true, streamId });
  if (!res.ok) {
    offChunk();
    offEnd();
    throw new Error(res.error);
  }
  return {
    streamId,
    cancel: () => void a.cancelStream({ streamId }),
  };
}

export async function listModels(args: {
  provider: Provider;
  baseUrl: string;
  apiKeyHandleId?: string;
  /** Plaintext key for the pre-add discovery path (see AiLabDiscoverSchema). */
  apiKey?: string;
}) {
  return api().listModels(args);
}

export async function testConnection(args: {
  provider: Provider;
  baseUrl: string;
  apiKeyHandleId?: string;
  /** Plaintext key for the pre-add discovery path (see AiLabDiscoverSchema). */
  apiKey?: string;
}) {
  return api().testConnection(args);
}
