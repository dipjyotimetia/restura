import { useState } from 'react';
import { useAiChatStore } from '@/features/ai/store';
import { ALL_PROVIDERS, getProviderModule } from '@shared/protocol/ai/providers';
import { getElectronAPI } from '@/lib/shared/platform';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Provider } from '@shared/protocol/ai/types';

const PROVIDER_LABELS: Record<Provider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
};

export function ProviderSettings() {
  const store = useAiChatStore();
  const [pendingKeys, setPendingKeys] = useState<Record<Provider, string>>({
    openai: '',
    anthropic: '',
    openrouter: '',
  });

  const saveKey = async (provider: Provider) => {
    const value = pendingKeys[provider].trim();
    if (!value) return;
    const api = getElectronAPI()?.secrets;
    if (!api) return;
    const result = await api.store({ scope: `ai:${provider}`, value, label: `${provider} key` });
    if (!result.ok) return;
    const providerModule = getProviderModule(provider);
    const defaultModel = store.providerConfigs[provider]?.defaultModel ?? providerModule.models[0]?.id ?? '';
    store.setProviderConfig(provider, {
      provider,
      defaultModel,
      apiKeyRef: { kind: 'handle', id: result.id, label: `${provider} key` },
    });
    setPendingKeys((p) => ({ ...p, [provider]: '' }));
  };

  const clearKey = async (provider: Provider) => {
    const handleId = store.providerConfigs[provider]?.apiKeyRef.id;
    const api = getElectronAPI()?.secrets;
    if (handleId && api) {
      await api.delete(handleId);
    }
    store.setProviderConfig(provider, null);
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label className="text-sm">Active provider</Label>
        <Select value={store.activeProvider} onValueChange={(v) => store.setActiveProvider(v as Provider)}>
          <SelectTrigger className="w-60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ALL_PROVIDERS.map((p) => (
              <SelectItem key={p} value={p}>
                {PROVIDER_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {ALL_PROVIDERS.map((provider) => {
        const cfg = store.providerConfigs[provider];
        const providerModule = getProviderModule(provider);
        return (
          <div key={provider} className="glass-1 rounded-lg border border-border/40 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">{PROVIDER_LABELS[provider]}</h3>
              {cfg && (
                <Button size="sm" variant="ghost" onClick={() => void clearKey(provider)}>
                  Remove key
                </Button>
              )}
            </div>
            {cfg ? (
              <>
                <div className="text-xs text-muted-foreground">
                  API key configured (handle {cfg.apiKeyRef.id.slice(0, 8)}…)
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Default model</Label>
                  <Select
                    value={cfg.defaultModel}
                    onValueChange={(model) => store.setProviderConfig(provider, { ...cfg, defaultModel: model })}
                  >
                    <SelectTrigger>
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
                <Label className="text-xs">API key</Label>
                <div className="flex gap-2">
                  <Input
                    type="password"
                    value={pendingKeys[provider]}
                    onChange={(e) => setPendingKeys((p) => ({ ...p, [provider]: e.target.value }))}
                    placeholder={provider === 'anthropic' ? 'sk-ant-…' : provider === 'openai' ? 'sk-…' : 'sk-or-…'}
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

      <div className="border-t border-border/40 pt-3 space-y-3">
        <div>
          <Label className="text-sm">Conversation history</Label>
          <p className="text-[11px] text-muted-foreground mb-2">
            All chats are stored locally (encrypted). Export wraps secrets as placeholders.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const blob = new Blob(
                  [JSON.stringify({ conversations: store.conversations, exportedAt: Date.now() }, null, 2)],
                  { type: 'application/json' },
                );
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `restura-ai-chats-${Date.now()}.json`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Export all (JSON)
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                if (window.confirm('Delete all conversations? This cannot be undone.')) {
                  for (const id of Object.keys(store.conversations)) store.deleteConversation(id);
                }
              }}
            >
              Clear all
            </Button>
          </div>
        </div>
      </div>

      <div className="text-[11px] text-muted-foreground">
        Note: providers may retain prompts up to 30 days. See your provider&apos;s privacy policy.
      </div>
    </div>
  );
}
