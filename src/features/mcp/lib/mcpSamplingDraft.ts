import { v4 as uuidv4 } from 'uuid';
import { consumeStream } from '@/features/ai/lib/streamConsumer';
import { useAiChatStore } from '@/features/ai/store';
import { getElectronAPI } from '@/lib/shared/platform';

/**
 * Optional AI-provider draft for an MCP `sampling/createMessage` request (#860).
 *
 * Reuses the AI assistant's configured provider + SecretRef key handle and the
 * existing `ai:chat` IPC path (redaction guard, SSRF guard, key resolution in
 * main). The result only fills the approval form — the user still reviews and
 * explicitly approves before anything is returned to the MCP server.
 */

export interface SamplingMessageView {
  role: 'user' | 'assistant';
  text: string;
}

export interface SamplingRequestView {
  messages: SamplingMessageView[];
  systemPrompt?: string;
  maxTokens?: number;
  modelHints: string[];
  priorities: Array<{ label: string; value: number }>;
  includeContext?: string;
  temperature?: number;
}

function blockText(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const typed = block as { type?: unknown; text?: unknown; mimeType?: unknown };
  if (typed.type === 'text' && typeof typed.text === 'string') return typed.text;
  const mime = typeof typed.mimeType === 'string' ? ` ${typed.mimeType}` : '';
  return `[${String(typed.type ?? 'unknown')} content${mime} omitted]`;
}

/** Normalise untrusted sampling params into a display-safe view. */
export function describeSamplingRequest(params: unknown): SamplingRequestView {
  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  const rawMessages = Array.isArray(p.messages) ? p.messages : [];
  const messages = rawMessages.map((message): SamplingMessageView => {
    const m = (message && typeof message === 'object' ? message : {}) as Record<string, unknown>;
    const content = Array.isArray(m.content) ? m.content : [m.content];
    return {
      role: m.role === 'assistant' ? 'assistant' : 'user',
      text: content.map(blockText).join('\n'),
    };
  });
  const prefs = (
    p.modelPreferences && typeof p.modelPreferences === 'object' ? p.modelPreferences : {}
  ) as Record<string, unknown>;
  const modelHints = Array.isArray(prefs.hints)
    ? prefs.hints
        .map((hint) => (hint as { name?: unknown } | null)?.name)
        .filter((name): name is string => typeof name === 'string')
    : [];
  const priorities = (['costPriority', 'speedPriority', 'intelligencePriority'] as const)
    .filter((key) => typeof prefs[key] === 'number')
    .map((key) => ({ label: key.replace('Priority', ''), value: prefs[key] as number }));
  return {
    messages,
    modelHints,
    priorities,
    ...(typeof p.systemPrompt === 'string' ? { systemPrompt: p.systemPrompt } : {}),
    ...(typeof p.maxTokens === 'number' ? { maxTokens: p.maxTokens } : {}),
    ...(typeof p.includeContext === 'string' ? { includeContext: p.includeContext } : {}),
    ...(typeof p.temperature === 'number' ? { temperature: p.temperature } : {}),
  };
}

/** The AI assistant provider that a draft would use, or null when none is configured. */
export function samplingDraftProvider(): { provider: string; model: string } | null {
  const { activeProvider, providerConfigs } = useAiChatStore.getState();
  const config = providerConfigs[activeProvider];
  if (!config?.defaultModel) return null;
  return { provider: activeProvider, model: config.defaultModel };
}

export type SamplingDraftResult =
  | { ok: true; text: string; model: string }
  | { ok: false; error: string };

/** Ask the configured AI assistant provider for a draft response. */
export async function draftSamplingWithAi(
  view: SamplingRequestView,
  onDelta?: (textSoFar: string) => void
): Promise<SamplingDraftResult> {
  const ai = getElectronAPI()?.ai;
  if (!ai) return { ok: false, error: 'AI provider drafts are only available in the desktop app.' };
  const { activeProvider, providerConfigs } = useAiChatStore.getState();
  const config = providerConfigs[activeProvider];
  if (!config?.defaultModel) {
    return { ok: false, error: 'Configure an AI provider in the AI assistant settings first.' };
  }

  const streamId = uuidv4();
  // Subscribe BEFORE invoking chat — see consumeStream's contract.
  const iterator = consumeStream(streamId)[Symbol.asyncIterator]();
  const started = await ai.chat({
    streamId,
    provider: activeProvider,
    model: config.defaultModel,
    messages: [
      ...(view.systemPrompt ? [{ role: 'system' as const, content: view.systemPrompt }] : []),
      ...view.messages.map((message) => ({ role: message.role, content: message.text })),
    ],
    ...(config.apiKeyRef?.id ? { apiKeyHandleId: config.apiKeyRef.id } : {}),
    ...(config.baseUrlOverride ? { baseUrlOverride: config.baseUrlOverride } : {}),
    // Keep the secret-redaction guard on: server-supplied prompts are untrusted.
    rawMode: false,
    ...(view.maxTokens ? { maxOutputTokens: view.maxTokens } : {}),
  });
  if (!started.ok) {
    await iterator.return?.();
    return { ok: false, error: started.error };
  }

  let text = '';
  for (;;) {
    const { value: event, done } = await iterator.next();
    if (done) break;
    if (event.type === 'delta') {
      text += event.text;
      onDelta?.(text);
    } else if (event.type === 'error') {
      await iterator.return?.();
      return { ok: false, error: event.message };
    }
  }
  return { ok: true, text, model: config.defaultModel };
}
