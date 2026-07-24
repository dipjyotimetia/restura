import { isLocalProvider, type Provider } from '@shared/protocol/ai/types';
import { RefreshCw, Server } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
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
import { Floater } from '@/components/ui/spatial';
import type { ProviderConnectionDraft } from '../lib/providerConnection';
import { PROVIDER_DEFAULT_BASE, providerRequiresApiKey } from '../lib/providerPolicy';
import type { AiLabProviderConfig } from '../types';

export const PROVIDER_OPTIONS: Array<{
  value: Provider;
  label: string;
  needsBaseUrl: boolean;
}> = [
  { value: 'ollama', label: 'Ollama (local)', needsBaseUrl: true },
  {
    value: 'openai-compatible',
    label: 'OpenAI-compatible (LM Studio, vLLM, Groq…)',
    needsBaseUrl: true,
  },
  { value: 'openai', label: 'OpenAI', needsBaseUrl: false },
  { value: 'anthropic', label: 'Anthropic', needsBaseUrl: false },
  { value: 'openrouter', label: 'OpenRouter', needsBaseUrl: false },
  { value: 'huggingface', label: 'HuggingFace Inference Providers', needsBaseUrl: false },
];

export interface ProviderCredentialDraft {
  label: string;
  baseUrl: string;
  /** Short-lived form value. It is handed directly to the keychain workflow. */
  apiKey: string;
}

export function ConnectProviderEditor({
  connecting,
  onConnect,
}: {
  connecting: boolean;
  onConnect: (draft: ProviderConnectionDraft) => Promise<boolean>;
}) {
  const [provider, setProvider] = useState<Provider>('ollama');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState(PROVIDER_DEFAULT_BASE.ollama);
  const [apiKey, setApiKey] = useState('');
  const selectedProvider = PROVIDER_OPTIONS.find((option) => option.value === provider)!;

  const onProviderChange = (next: Provider) => {
    setProvider(next);
    setBaseUrl(PROVIDER_DEFAULT_BASE[next]);
    if (!label.trim()) {
      setLabel(
        PROVIDER_OPTIONS.find((option) => option.value === next)?.label.split(' (')[0] ?? ''
      );
    }
  };

  const connect = async () => {
    const name = label.trim();
    const resolvedBaseUrl = baseUrl.trim() || PROVIDER_DEFAULT_BASE[provider];
    if (!name) {
      toast.error('Give this provider a recognizable name.');
      return;
    }
    if (!resolvedBaseUrl) {
      toast.error('Enter the provider base URL.');
      return;
    }
    if (providerRequiresApiKey(provider) && !apiKey.trim()) {
      toast.error(`${selectedProvider.label} requires an API key before it can run models.`);
      return;
    }
    if (await onConnect({ provider, label: name, baseUrl: resolvedBaseUrl, apiKey })) {
      setLabel('');
      setApiKey('');
    }
  };

  return (
    <Floater radius="panel" elevation="float" className="mb-3 space-y-3 bg-sp-surface p-3">
      <div>
        <h3 className="text-sp-12 font-semibold text-sp-text">Connect a provider</h3>
        <p className="mt-0.5 text-sp-10 text-sp-muted">
          Restura tests the connection and imports its models before saving.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ailab-provider-type" className="sp-label">
          Type
        </Label>
        <Select value={provider} onValueChange={(value) => onProviderChange(value as Provider)}>
          <SelectTrigger id="ailab-provider-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ailab-provider-name" className="sp-label">
          Name
        </Label>
        <Input
          id="ailab-provider-name"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="e.g. Local Ollama"
        />
      </div>
      {(selectedProvider.needsBaseUrl || isLocalProvider(provider)) && (
        <div className="space-y-1.5">
          <Label htmlFor="ailab-provider-baseurl" className="sp-label">
            Base URL
          </Label>
          <Input
            id="ailab-provider-baseurl"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="http://localhost:11434"
          />
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="ailab-provider-key" className="sp-label">
          API key {providerRequiresApiKey(provider) ? '' : '(optional)'}
        </Label>
        <Input
          id="ailab-provider-key"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={
            isLocalProvider(provider)
              ? 'Usually not required'
              : provider === 'huggingface'
                ? 'hf_…'
                : providerRequiresApiKey(provider)
                  ? 'Required'
                  : 'sk-…'
          }
        />
        <p className="text-sp-10 text-sp-muted">
          Stored in your OS keychain after connection succeeds.
        </p>
      </div>
      <Button
        variant="cta"
        size="cta"
        className="w-full"
        disabled={connecting}
        onClick={() => void connect()}
      >
        {connecting ? (
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Server className="h-3.5 w-3.5" />
        )}
        {connecting ? 'Connecting and discovering…' : 'Connect & save'}
      </Button>
    </Floater>
  );
}

export function EditProviderCredentials({
  config,
  saving,
  onSave,
  onCancel,
}: {
  config: AiLabProviderConfig;
  saving: boolean;
  onSave: (draft: ProviderCredentialDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ProviderCredentialDraft>({
    label: config.label,
    baseUrl: config.baseUrl ?? '',
    apiKey: '',
  });

  return (
    <div className="mt-2 space-y-2 border-t border-sp-line pt-2">
      <Input
        value={draft.label}
        aria-label="Provider name"
        onChange={(event) => setDraft({ ...draft, label: event.target.value })}
      />
      <Input
        value={draft.baseUrl}
        aria-label="Provider base URL"
        placeholder={PROVIDER_DEFAULT_BASE[config.provider] || 'https://…'}
        onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
      />
      <Input
        type="password"
        value={draft.apiKey}
        aria-label="Replace API key"
        placeholder={config.apiKeyHandleId ? 'Leave blank to keep current key' : 'New API key'}
        onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
      />
      <div className="flex gap-1">
        <Button size="sm" disabled={saving} onClick={() => onSave(draft)}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
