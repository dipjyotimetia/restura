import { CLOUD_PROVIDERS, getProviderModule } from '@shared/protocol/ai/providers';
import { redactBody } from '@shared/protocol/ai/redaction';
import type { ChatProvider, CloudProvider } from '@shared/protocol/ai/types';
import { useState } from 'react';
import { useConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { type Conversation, useAiChatStore } from '@/features/ai/store';
import { getElectronAPI } from '@/lib/shared/platform';

// The chat panel talks to the cloud providers plus a local OpenAI-compatible
// endpoint (Ollama/LM Studio/vLLM at a user-supplied base URL, no API key).
const PROVIDER_LABELS: Record<ChatProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  'openai-compatible': 'OpenAI-compatible (local)',
};

const CHAT_PROVIDERS: readonly ChatProvider[] = [...CLOUD_PROVIDERS, 'openai-compatible'];

/**
 * Redact secret-shaped content from conversation message text before export.
 * The UI promises "Export wraps secrets as placeholders"; raw-mode messages can
 * carry unredacted secrets in their text (or an assistant reply that echoed one
 * back), so apply the same default-mode redaction the prompt builder uses. API
 * keys themselves are never in conversations — they live as handle refs in
 * providerConfigs, which are NOT exported.
 */
function redactConversationsForExport(
  conversations: Record<string, Conversation>
): Record<string, Conversation> {
  const out: Record<string, Conversation> = {};
  for (const [id, conv] of Object.entries(conversations)) {
    out[id] = {
      ...conv,
      messages: conv.messages.map((m) => ({
        ...m,
        text: redactBody(m.text, 'default'),
        ...(m.errorMessage ? { errorMessage: redactBody(m.errorMessage, 'default') } : {}),
      })),
    };
  }
  return out;
}

export function ProviderSettings() {
  // Granular selectors: this drawer must NOT subscribe to `conversations`, which
  // churns on every streamed delta — it would re-render the whole settings panel
  // mid-stream. `providerConfigs` only changes on key/model edits. Conversations
  // are read lazily from the store inside the export/clear handlers.
  const activeProvider = useAiChatStore((s) => s.activeProvider);
  const providerConfigs = useAiChatStore((s) => s.providerConfigs);
  const setActiveProvider = useAiChatStore((s) => s.setActiveProvider);
  const setProviderConfig = useAiChatStore((s) => s.setProviderConfig);
  const deleteConversation = useAiChatStore((s) => s.deleteConversation);

  const [pendingKeys, setPendingKeys] = useState<Record<CloudProvider, string>>({
    openai: '',
    anthropic: '',
    openrouter: '',
  });
  const [removingKey, setRemovingKey] = useState<CloudProvider | null>(null);
  const { confirm: confirmRemoveKey, DialogComponent: RemoveKeyDialog } = useConfirmDialog({
    title: 'Remove API key',
    description: removingKey
      ? `Remove the ${PROVIDER_LABELS[removingKey]} API key? It will be deleted from the OS keychain and you'll need to re-enter it to use this provider again.`
      : '',
    confirmText: 'Remove',
    variant: 'destructive',
  });
  const { confirm: confirmClearAll, DialogComponent: ClearAllDialog } = useConfirmDialog({
    title: 'Delete all conversations',
    description: 'This deletes every saved AI chat conversation. This cannot be undone.',
    confirmText: 'Delete all',
    variant: 'destructive',
  });

  // Local (openai-compatible) provider draft: base URL + model id, no API key.
  const localCfg = providerConfigs['openai-compatible'];
  const [localBaseUrl, setLocalBaseUrl] = useState(localCfg?.baseUrlOverride ?? '');
  const [localModel, setLocalModel] = useState(localCfg?.defaultModel ?? '');

  const saveLocal = () => {
    const url = localBaseUrl.trim();
    const model = localModel.trim();
    if (!url || !model) return;
    setProviderConfig('openai-compatible', {
      provider: 'openai-compatible',
      defaultModel: model,
      baseUrlOverride: url,
    });
  };

  const saveKey = async (provider: CloudProvider) => {
    const value = pendingKeys[provider].trim();
    if (!value) return;
    const api = getElectronAPI()?.secrets;
    if (!api) return;
    const result = await api.store({ scope: `ai:${provider}`, value, label: `${provider} key` });
    if (!result.ok) return;
    const providerModule = getProviderModule(provider);
    const defaultModel =
      providerConfigs[provider]?.defaultModel ?? providerModule.models[0]?.id ?? '';
    setProviderConfig(provider, {
      provider,
      defaultModel,
      apiKeyRef: { kind: 'handle', id: result.id, label: `${provider} key` },
    });
    setPendingKeys((p) => ({ ...p, [provider]: '' }));
  };

  const clearKey = async (provider: CloudProvider) => {
    const handleId = providerConfigs[provider]?.apiKeyRef?.id;
    const api = getElectronAPI()?.secrets;
    if (handleId && api) {
      await api.delete(handleId);
    }
    setProviderConfig(provider, null);
  };

  const handleRemoveKeyClick = async (provider: CloudProvider) => {
    setRemovingKey(provider);
    if (await confirmRemoveKey()) await clearKey(provider);
  };

  const exportAll = () => {
    const conversations = useAiChatStore.getState().conversations;
    const blob = new Blob(
      [
        JSON.stringify(
          { conversations: redactConversationsForExport(conversations), exportedAt: Date.now() },
          null,
          2
        ),
      ],
      { type: 'application/json' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `restura-ai-chats-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const clearAll = () => {
    const conversations = useAiChatStore.getState().conversations;
    for (const id of Object.keys(conversations)) deleteConversation(id);
  };

  const handleClearAllClick = async () => {
    if (await confirmClearAll()) clearAll();
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="ai-active-provider" className="text-sm">
          Active provider
        </Label>
        <Select value={activeProvider} onValueChange={(v) => setActiveProvider(v as ChatProvider)}>
          <SelectTrigger id="ai-active-provider" className="w-60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHAT_PROVIDERS.map((p) => (
              <SelectItem key={p} value={p}>
                {PROVIDER_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {CLOUD_PROVIDERS.map((provider) => {
        const cfg = providerConfigs[provider];
        const providerModule = getProviderModule(provider);
        return (
          <div key={provider} className="sp-floater rounded-lg p-3 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">{PROVIDER_LABELS[provider]}</h3>
              {cfg && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleRemoveKeyClick(provider)}
                >
                  Remove key
                </Button>
              )}
            </div>
            {cfg ? (
              <>
                <div className="text-xs text-muted-foreground">
                  API key configured (handle {cfg.apiKeyRef?.id.slice(0, 8)}…)
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`ai-model-${provider}`} className="text-xs">
                    Default model
                  </Label>
                  <Select
                    value={cfg.defaultModel}
                    onValueChange={(model) =>
                      setProviderConfig(provider, { ...cfg, defaultModel: model })
                    }
                  >
                    <SelectTrigger id={`ai-model-${provider}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {providerModule.models.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.label} — ${m.inputUSDPerMTok}/MTok in · ${m.outputUSDPerMTok}/MTok out
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <Label htmlFor={`ai-key-${provider}`} className="text-xs">
                  API key
                </Label>
                <div className="flex gap-2">
                  <Input
                    id={`ai-key-${provider}`}
                    type="password"
                    value={pendingKeys[provider]}
                    onChange={(e) => setPendingKeys((p) => ({ ...p, [provider]: e.target.value }))}
                    placeholder={
                      provider === 'anthropic'
                        ? 'sk-ant-…'
                        : provider === 'openai'
                          ? 'sk-…'
                          : 'sk-or-…'
                    }
                  />
                  <Button size="sm" onClick={() => void saveKey(provider)}>
                    Save
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Stored encrypted in the OS keychain. Never sent to Restura&apos;s servers.
                </p>
              </div>
            )}
          </div>
        );
      })}

      {/* Local OpenAI-compatible provider — base URL + model, no API key. */}
      <div className="sp-floater rounded-lg p-3 space-y-3">
        <h3 className="text-sm font-medium">{PROVIDER_LABELS['openai-compatible']}</h3>
        <div className="space-y-1">
          <Label htmlFor="ai-local-baseurl" className="text-xs">
            Base URL
          </Label>
          <Input
            id="ai-local-baseurl"
            value={localBaseUrl}
            onChange={(e) => setLocalBaseUrl(e.target.value)}
            placeholder="http://localhost:11434"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ai-local-model" className="text-xs">
            Model
          </Label>
          <Input
            id="ai-local-model"
            value={localModel}
            onChange={(e) => setLocalModel(e.target.value)}
            placeholder="e.g. llama3.1 (local model id)"
          />
        </div>
        <Button
          size="sm"
          aria-label="Save local provider"
          onClick={saveLocal}
          disabled={!localBaseUrl.trim() || !localModel.trim()}
        >
          Save local provider
        </Button>
        {localCfg && (
          <p className="text-[11px] text-muted-foreground">
            Configured: {localCfg.baseUrlOverride} · {localCfg.defaultModel}
          </p>
        )}
      </div>

      <div className="border-t border-border/40 pt-3 space-y-3">
        <div>
          <Label className="text-sm">Conversation history</Label>
          <p className="text-[11px] text-muted-foreground mb-2">
            All chats are stored locally (encrypted). Export redacts recognizable secrets to
            placeholders.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={exportAll}>
              Export all (JSON)
            </Button>
            <Button size="sm" variant="destructive" onClick={() => void handleClearAllClick()}>
              Clear all
            </Button>
          </div>
        </div>
      </div>

      <div className="text-[11px] text-muted-foreground">
        Note: providers may retain prompts up to 30 days. See your provider&apos;s privacy policy.
      </div>

      <RemoveKeyDialog />
      <ClearAllDialog />
    </div>
  );
}
