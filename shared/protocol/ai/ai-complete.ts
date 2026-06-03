import type { Fetcher } from '@shared/protocol/types';
import { executeAiChat } from './ai-proxy';
import type { ChatRequestSpec, ChatToolCall, CompletionResult, Usage } from './types';

type SecretResolver = (handleId: string) => Promise<string | undefined>;

/**
 * Drain {@link executeAiChat} to completion and return a single
 * {@link CompletionResult}. This is the non-streaming path the eval runner and
 * the LLM-as-judge scorer use: an eval over datasets × models × scorers wants
 * the final text + usage per cell, not per-token UI updates — and pushing
 * hundreds of cells through the per-chunk IPC event channel would be a lot of
 * traffic for no benefit.
 *
 * The same provider routing, decoding, SSRF/secret resolution, and abort
 * handling as the streaming path apply — this only changes how events are
 * consumed (accumulated here instead of emitted to the renderer).
 */
export async function runToCompletion(
  spec: ChatRequestSpec,
  fetcher: Fetcher,
  secretResolver: SecretResolver
): Promise<CompletionResult> {
  let text = '';
  let usage: Usage | undefined;
  const toolCalls: ChatToolCall[] = [];
  let error: CompletionResult['error'];

  for await (const ev of executeAiChat(spec, fetcher, secretResolver)) {
    switch (ev.type) {
      case 'delta':
        text += ev.text;
        break;
      case 'tool_call':
        toolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
        break;
      case 'usage':
        usage = ev.usage;
        break;
      case 'error':
        // Keep the first error; the orchestrator emits at most one before `done`.
        if (!error) error = { code: ev.code, message: ev.message };
        break;
      case 'done':
        break;
    }
  }

  return {
    ok: !error,
    text,
    toolCalls,
    ...(usage ? { usage } : {}),
    ...(error ? { error } : {}),
  };
}
