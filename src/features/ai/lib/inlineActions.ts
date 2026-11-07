/**
 * Inline AI actions — the "Postbot-style" one-click buttons mounted on the
 * request/response UI (Fix request, Generate tests, Enrich docs). Each dispatcher
 * queues a seeded chat message via the AI store; the ChatPanel consumes it
 * through the SAME `handleSend` path as manual chat (no forked streaming), and
 * the resulting tool proposal flows through the existing propose-&-apply card.
 *
 * Electron-only, like the rest of the AI assistant.
 */
import { providerReadiness } from '@/features/ai/lib/providerReadiness';
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
 * Reactive state of inline AI actions: hidden off-desktop (the assistant is
 * Electron-only); on desktop, 'unconfigured' until the active provider is
 * usable (shown disabled with a configure hint), else 'ready'. Uses the same
 * readiness rule as the chat composer.
 */
export function useAiActionsState(): 'hidden' | 'unconfigured' | 'ready' {
  const activeProvider = useAiChatStore((s) => s.activeProvider);
  const cfg = useAiChatStore((s) => s.providerConfigs[s.activeProvider]);
  if (!isElectron()) return 'hidden';
  return providerReadiness(activeProvider, cfg) === 'ready' ? 'ready' : 'unconfigured';
}

/** Whether inline AI actions can run right now (desktop + a usable provider). */
export function useAiActionsAvailable(): boolean {
  return useAiActionsState() === 'ready';
}

export const CONFIGURE_AI_HINT = 'Configure an AI provider in Settings → AI to use AI actions';
