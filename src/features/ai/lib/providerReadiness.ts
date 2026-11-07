/**
 * Whether the assistant's active provider can be used, and what is missing
 * when it can't. A cloud provider needs an API-key handle; a local
 * (openai-compatible) provider needs a base URL and no key. Single source for
 * the chat composer, the setup card and the inline AI actions.
 */
import { type ChatProvider, isLocalProvider } from '@shared/protocol/ai/types';
import type { ProviderConfig } from '@/features/ai/store';

export type ProviderReadiness = 'ready' | 'missing-key' | 'missing-base-url';

export function providerReadiness(
  provider: ChatProvider,
  // Structural (not ProviderConfig) so callers compiled under
  // exactOptionalPropertyTypes (the http feature, via inline actions) type-check.
  cfg:
    | {
        apiKeyRef?: Pick<NonNullable<ProviderConfig['apiKeyRef']>, 'id'> | undefined;
        baseUrlOverride?: string | undefined;
      }
    | null
    | undefined
): ProviderReadiness {
  if (isLocalProvider(provider)) return cfg?.baseUrlOverride ? 'ready' : 'missing-base-url';
  return cfg?.apiKeyRef?.id ? 'ready' : 'missing-key';
}

/** Open the Settings drawer on the AI section (handled by the app shell). */
export function openAiSettings(): void {
  window.dispatchEvent(new CustomEvent('restura:open-settings', { detail: 'ai' }));
}

export const AI_PROVIDER_LABELS: Record<ChatProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  'openai-compatible': 'OpenAI-compatible (local)',
};
