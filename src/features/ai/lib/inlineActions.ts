/**
 * Inline AI actions — the "Postbot-style" one-click buttons mounted on the
 * request/response UI (Fix request, Generate tests, Enrich docs). Each dispatcher
 * queues a seeded chat message via the AI store; the ChatPanel consumes it
 * through the SAME `handleSend` path as manual chat (no forked streaming), and
 * the resulting tool proposal flows through the existing propose-&-apply card.
 *
 * Electron-only, like the rest of the AI assistant.
 */
import { isLocalProvider } from '@shared/protocol/ai/types';
import { useAiChatStore } from '@/features/ai/store';
import { isElectron } from '@/lib/shared/platform';

export type InlineAiAction = 'fix' | 'generate-tests' | 'enrich-docs';

/** Display order for menus / button rows. */
export const INLINE_ACTIONS: ReadonlyArray<InlineAiAction> = [
  'fix',
  'generate-tests',
  'enrich-docs',
];

/**
 * Single source of truth for action labels — consumed by AiActionsMenu and
 * AiActionButton so the menu and the toolbar button can't drift apart.
 */
export const INLINE_ACTION_LABELS: Record<InlineAiAction, string> = {
  fix: 'Fix request',
  'generate-tests': 'Generate tests',
  'enrich-docs': 'Enrich docs',
};

/**
 * Seeded prompts. Each names the exact tool to call so the model proposes the
 * intended action; the user still approves before anything mutates.
 */
const ACTION_PROMPTS: Record<InlineAiAction, string> = {
  fix:
    'This request is failing or looks incorrect. Diagnose the problem from the ' +
    'request and its response in the context, then call update_http_request with ' +
    'only the fields that need to change. Briefly explain what you changed and why.',
  'generate-tests':
    "Write a thorough test script for this request's response: assert the status " +
    'code, the presence and types of the key fields in the body, and a couple of ' +
    'sensible edge cases. Then apply it by calling set_test_script. Use Restura’s ' +
    'rs.* assertions (pm.* also works).',
  'enrich-docs':
    'Write clear, concise markdown documentation for this request — what it does, ' +
    'its parameters/headers, and an example response based on the context — then ' +
    'apply it by calling enrich_docs.',
};

/** Imperatively queue an inline action. Opens the AI panel (via the store). */
export function dispatchInlineAiAction(action: InlineAiAction): void {
  useAiChatStore.getState().enqueueAction({ userText: ACTION_PROMPTS[action] });
}

/**
 * Reactive guard for whether inline AI actions can run: Electron + a configured
 * active provider (cloud key handle present, or a local provider with a base
 * URL). Mirrors the `apiKeyConfigured` logic in ChatPanel so buttons disable in
 * exactly the cases the chat composer does.
 */
export function useAiActionsAvailable(): boolean {
  const cfg = useAiChatStore((s) => s.providerConfigs[s.activeProvider]);
  if (!isElectron()) return false;
  if (!cfg) return false;
  return isLocalProvider(cfg.provider) ? !!cfg.baseUrlOverride : !!cfg.apiKeyRef?.id;
}
