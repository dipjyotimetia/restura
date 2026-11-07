import { Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AI_PROVIDER_LABELS,
  openAiSettings,
  providerReadiness,
} from '@/features/ai/lib/providerReadiness';
import { useAiChatStore } from '@/features/ai/store';

/**
 * Empty-state card shown in the chat panel while the active provider is not
 * usable: names the provider and what is missing (an API key for a cloud
 * provider, a base URL for a local one), with a shortcut to Settings → AI.
 */
export function ProviderSetupCard() {
  const activeProvider = useAiChatStore((s) => s.activeProvider);
  const cfg = useAiChatStore((s) => s.providerConfigs[s.activeProvider]);
  const readiness = providerReadiness(activeProvider, cfg);
  if (readiness === 'ready') return null;
  const label = AI_PROVIDER_LABELS[activeProvider];
  return (
    <div
      data-testid="ai-provider-setup"
      className="m-2 rounded-lg border border-sp-line bg-sp-surface p-3 text-xs"
    >
      <p className="font-medium">
        {readiness === 'missing-key'
          ? `${label} needs an API key`
          : `${label} needs a base URL and model`}
      </p>
      <p className="mt-1 text-muted-foreground">
        {readiness === 'missing-key'
          ? 'Save a key for this provider, or pick another provider, in Settings → AI.'
          : 'Point it at your local server (e.g. Ollama or LM Studio) in Settings → AI.'}
      </p>
      <Button size="sm" variant="outline" className="mt-2" onClick={openAiSettings}>
        <Settings className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Open AI settings
      </Button>
    </div>
  );
}
