import { useState } from 'react';
import { toast } from 'sonner';
import { Server, Trash2, Wifi, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Floater } from '@/components/ui/spatial';
import { getElectronAPI } from '@/lib/shared/platform';
import { isLocalProvider, type Provider } from '@shared/protocol/ai/types';
import { listModels, testConnection } from '../lib/llmClient';
import { useAiLabStore } from '../store/useAiLabStore';
import { EmptyState } from './EmptyState';
import type { AiLabProviderConfig } from '../types';

const PROVIDER_OPTIONS: Array<{ value: Provider; label: string; needsBaseUrl: boolean }> = [
  { value: 'ollama', label: 'Ollama (local)', needsBaseUrl: true },
  {
    value: 'openai-compatible',
    label: 'OpenAI-compatible (LM Studio, vLLM, Groq…)',
    needsBaseUrl: true,
  },
  { value: 'openai', label: 'OpenAI', needsBaseUrl: false },
  { value: 'anthropic', label: 'Anthropic', needsBaseUrl: false },
  { value: 'openrouter', label: 'OpenRouter', needsBaseUrl: false },
];

const DEFAULT_BASE: Record<Provider, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  openrouter: 'https://openrouter.ai/api',
  ollama: 'http://localhost:11434',
  'openai-compatible': '',
};

function effectiveBaseUrl(cfg: AiLabProviderConfig): string {
  return cfg.baseUrl || DEFAULT_BASE[cfg.provider];
}

export function ProviderManager() {
  const providers = useAiLabStore((s) => s.providers);
  const addProvider = useAiLabStore((s) => s.addProvider);
  const removeProvider = useAiLabStore((s) => s.removeProvider);
  const setProviderModels = useAiLabStore((s) => s.setProviderModels);

  const [provider, setProvider] = useState<Provider>('ollama');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('http://localhost:11434');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const opt = PROVIDER_OPTIONS.find((o) => o.value === provider)!;

  const onProviderChange = (v: Provider) => {
    setProvider(v);
    setBaseUrl(DEFAULT_BASE[v]);
  };

  const add = async () => {
    if (!label.trim()) {
      toast.error('Give the provider a name.');
      return;
    }
    let apiKeyHandleId: string | undefined;
    if (apiKey.trim()) {
      const secrets = getElectronAPI()?.secrets;
      const res = await secrets?.store({
        scope: 'ai-lab',
        value: apiKey.trim(),
        label: `${label} key`,
      });
      if (!res?.ok) {
        toast.error('Failed to store API key.');
        return;
      }
      apiKeyHandleId = res.id;
    }
    addProvider({
      provider,
      label: label.trim(),
      ...(opt.needsBaseUrl || baseUrl ? { baseUrl: baseUrl.trim() } : {}),
      ...(apiKeyHandleId ? { apiKeyHandleId } : {}),
    });
    setLabel('');
    setApiKey('');
    toast.success(`Added ${label.trim()}`);
  };

  const discover = async (cfg: AiLabProviderConfig) => {
    setBusy(cfg.id);
    try {
      const res = await listModels({
        provider: cfg.provider,
        baseUrl: effectiveBaseUrl(cfg),
        ...(cfg.apiKeyHandleId ? { apiKeyHandleId: cfg.apiKeyHandleId } : {}),
      });
      if (!res.ok) {
        toast.error(`Discovery failed: ${res.error}`);
        return;
      }
      setProviderModels(
        cfg.id,
        res.models.map((m) => m.id)
      );
      toast.success(`Found ${res.models.length} model(s)`);
    } finally {
      setBusy(null);
    }
  };

  const test = async (cfg: AiLabProviderConfig) => {
    setBusy(cfg.id);
    try {
      const res = await testConnection({
        provider: cfg.provider,
        baseUrl: effectiveBaseUrl(cfg),
        ...(cfg.apiKeyHandleId ? { apiKeyHandleId: cfg.apiKeyHandleId } : {}),
      });
      if (res.ok) toast.success(`Connected — ${res.modelCount} model(s) available`);
      else toast.error(`Connection failed: ${res.error}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
        <Floater radius="panel" elevation="float" className="space-y-3 bg-sp-surface p-4">
          <h2 className="text-sp-13 font-semibold text-sp-text">Add a provider</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <span className="sp-label">Type</span>
              <Select value={provider} onValueChange={(v) => onProviderChange(v as Provider)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <span className="sp-label">Name</span>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Local Ollama"
              />
            </div>
            {(opt.needsBaseUrl || isLocalProvider(provider)) && (
              <div className="space-y-1.5">
                <span className="sp-label">Base URL</span>
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="http://localhost:11434"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <span className="sp-label">
                API key {isLocalProvider(provider) ? '(optional)' : ''}
              </span>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={isLocalProvider(provider) ? 'usually not required' : 'sk-…'}
              />
            </div>
          </div>
          <Button onClick={() => void add()} variant="secondary" size="sm">
            Add provider
          </Button>
        </Floater>

        <section className="space-y-2">
          <h2 className="text-sp-13 font-semibold text-sp-text">Providers</h2>
          {Object.values(providers).length === 0 && (
            <EmptyState icon={Server} message="No providers yet. Add one above." />
          )}
          {Object.values(providers).map((cfg) => (
            <Floater
              key={cfg.id}
              radius="panel"
              elevation="inset"
              className="flex items-center justify-between gap-3 p-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sp-13 font-medium text-sp-text">{cfg.label}</span>
                  <span className="shrink-0 rounded-sp-chip bg-sp-surface-hi px-1.5 py-0.5 text-sp-11 font-medium uppercase tracking-wide text-sp-muted">
                    {cfg.provider}
                  </span>
                  {cfg.isLocal && (
                    <span className="shrink-0 text-sp-11 font-medium text-emerald-500">local</span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-sp-12 text-sp-muted">
                  {effectiveBaseUrl(cfg)} · {cfg.models.length} model(s)
                  {!cfg.pricingKnown && ' · cost unknown'}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Test connection"
                  title="Test connection"
                  disabled={busy === cfg.id}
                  onClick={() => void test(cfg)}
                >
                  <Wifi className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Discover models"
                  title="Discover models"
                  disabled={busy === cfg.id}
                  onClick={() => void discover(cfg)}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${busy === cfg.id ? 'animate-spin' : ''}`} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove provider"
                  title="Remove provider"
                  onClick={() => removeProvider(cfg.id)}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            </Floater>
          ))}
        </section>
      </div>
    </div>
  );
}
