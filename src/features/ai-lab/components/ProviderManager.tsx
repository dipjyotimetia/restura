import type { ModelCapabilities, Modality } from '@shared/agent-lab';
import { isLocalProvider, type Provider } from '@shared/protocol/ai/types';
import {
  CheckCircle2,
  ChevronUp,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  SlidersHorizontal,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { capabilitiesForDesktopModel } from '../lib/agentModelCapabilities';
import { listModels, testConnection } from '../lib/llmClient';
import { buildModelOptions } from '../lib/modelOptions';
import { plural } from '../lib/plural';
import {
  connectAndAddProvider,
  deleteSecretHandle,
  replaceSecretHandle,
  splitDiscoveredModels,
} from '../lib/providerConnection';
import { useAiLabStore } from '../store/useAiLabStore';
import type { AiLabProviderConfig } from '../types';
import { ModelCatalog } from './ModelCatalog';
import { useConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { formatRelativeTime } from '@/lib/shared/console-format';
import { getElectronAPI } from '@/lib/shared/platform';
import { cn } from '@/lib/shared/utils';

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
  {
    value: 'huggingface',
    label: 'HuggingFace Inference Providers',
    needsBaseUrl: false,
  },
];

const DEFAULT_BASE: Record<Provider, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  openrouter: 'https://openrouter.ai/api',
  ollama: 'http://localhost:11434',
  huggingface: 'https://router.huggingface.co',
  'openai-compatible': '',
};

const BOOLEAN_CAPABILITIES: Array<{
  key: keyof Pick<
    ModelCapabilities,
    'structuredOutput' | 'toolCalling' | 'parallelToolCalls' | 'reasoning' | 'continuation'
  >;
  label: string;
}> = [
  { key: 'toolCalling', label: 'Tool calling' },
  { key: 'parallelToolCalls', label: 'Parallel tool calls' },
  { key: 'structuredOutput', label: 'Structured output' },
  { key: 'reasoning', label: 'Reasoning controls' },
  { key: 'continuation', label: 'Continuation' },
];

const OPTIONAL_MODALITIES: Array<{ value: Exclude<Modality, 'text'>; label: string }> = [
  { value: 'image', label: 'Image' },
  { value: 'audio', label: 'Audio' },
  { value: 'document', label: 'Document' },
];

function effectiveBaseUrl(cfg: AiLabProviderConfig): string {
  return cfg.baseUrl || DEFAULT_BASE[cfg.provider];
}

function requiresApiKey(provider: Provider): boolean {
  return (
    provider === 'openai' ||
    provider === 'anthropic' ||
    provider === 'openrouter' ||
    provider === 'huggingface'
  );
}

export function ProviderManager() {
  const providers = useAiLabStore((state) => state.providers);
  const favoriteModelKeys = useAiLabStore((state) => state.favoriteModelKeys);
  const recentModelKeys = useAiLabStore((state) => state.recentModelKeys);
  const addProvider = useAiLabStore((state) => state.addProvider);
  const updateProvider = useAiLabStore((state) => state.updateProvider);
  const removeProvider = useAiLabStore((state) => state.removeProvider);
  const setProviderModels = useAiLabStore((state) => state.setProviderModels);
  const toggleFavoriteModel = useAiLabStore((state) => state.toggleFavoriteModel);

  const providerList = useMemo(() => Object.values(providers), [providers]);
  const modelOptions = useMemo(
    () => buildModelOptions(providers, { favoriteModelKeys, recentModelKeys }),
    [providers, favoriteModelKeys, recentModelKeys]
  );
  const favoriteSet = useMemo(() => new Set(favoriteModelKeys), [favoriteModelKeys]);

  const [showAdd, setShowAdd] = useState(providerList.length === 0);
  const [provider, setProvider] = useState<Provider>('ollama');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE.ollama);
  const [apiKey, setApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState<{ id: string; action: 'test' | 'discover' } | null>(null);
  const [editing, setEditing] = useState<{
    id: string;
    label: string;
    baseUrl: string;
    apiKey: string;
  } | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [removing, setRemoving] = useState<AiLabProviderConfig | null>(null);
  const [capabilityEditing, setCapabilityEditing] = useState<{
    providerId: string;
    model: string;
    draft: ModelCapabilities;
    assertionConfirmed: boolean;
  } | null>(null);

  const { confirm: confirmRemove, DialogComponent: RemoveProviderDialog } = useConfirmDialog({
    title: 'Remove provider',
    description: removing
      ? `Remove “${removing.label}”? Its keychain secret and model catalog will also be removed.`
      : '',
    confirmText: 'Remove provider',
    variant: 'destructive',
  });

  const selectedProvider = PROVIDER_OPTIONS.find((option) => option.value === provider)!;

  const onProviderChange = (next: Provider) => {
    setProvider(next);
    setBaseUrl(DEFAULT_BASE[next]);
    if (!label.trim()) {
      setLabel(
        PROVIDER_OPTIONS.find((option) => option.value === next)?.label.split(' (')[0] ?? ''
      );
    }
  };

  const connect = async () => {
    const name = label.trim();
    const resolvedBaseUrl = baseUrl.trim() || DEFAULT_BASE[provider];
    if (!name) {
      toast.error('Give this provider a recognizable name.');
      return;
    }
    if (!resolvedBaseUrl) {
      toast.error('Enter the provider base URL.');
      return;
    }
    if (requiresApiKey(provider) && !apiKey.trim()) {
      toast.error(`${selectedProvider.label} requires an API key before it can run models.`);
      return;
    }
    const electron = getElectronAPI();
    if (!electron) {
      toast.error('Provider setup is only available in the desktop app.');
      return;
    }

    setConnecting(true);
    try {
      const result = await connectAndAddProvider(
        { provider, label: name, baseUrl: resolvedBaseUrl, apiKey },
        {
          storeSecret: electron.secrets.store,
          deleteSecret: electron.secrets.delete,
          discoverModels: listModels,
          addProvider,
        }
      );
      if (!result.ok) {
        toast.error(`Could not connect: ${result.error}`);
        return;
      }
      toast.success(`Connected ${name} with ${plural(result.modelCount, 'model')}`);
      setLabel('');
      setApiKey('');
      setShowAdd(false);
    } finally {
      setConnecting(false);
    }
  };

  const discover = async (cfg: AiLabProviderConfig) => {
    setBusy({ id: cfg.id, action: 'discover' });
    try {
      const result = await listModels({
        provider: cfg.provider,
        baseUrl: effectiveBaseUrl(cfg),
        ...(cfg.apiKeyHandleId ? { apiKeyHandleId: cfg.apiKeyHandleId } : {}),
      });
      if (!result.ok) {
        updateProvider(cfg.id, { lastTest: { ok: false, at: Date.now(), error: result.error } });
        toast.error(`Catalog refresh failed: ${result.error}`);
        return;
      }
      const { models, modelDetails } = splitDiscoveredModels(result.models);
      setProviderModels(cfg.id, models, modelDetails);
      updateProvider(cfg.id, {
        lastTest: { ok: true, at: Date.now(), modelCount: models.length },
      });
      toast.success(`Refreshed ${cfg.label}: ${plural(models.length, 'model')}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateProvider(cfg.id, { lastTest: { ok: false, at: Date.now(), error: message } });
      toast.error(`Catalog refresh failed: ${message}`);
    } finally {
      setBusy(null);
    }
  };

  const test = async (cfg: AiLabProviderConfig) => {
    setBusy({ id: cfg.id, action: 'test' });
    try {
      const result = await testConnection({
        provider: cfg.provider,
        baseUrl: effectiveBaseUrl(cfg),
        ...(cfg.apiKeyHandleId ? { apiKeyHandleId: cfg.apiKeyHandleId } : {}),
      });
      if (result.ok) {
        updateProvider(cfg.id, {
          lastTest: { ok: true, at: Date.now(), modelCount: result.modelCount },
        });
        toast.success(`Connected — ${plural(result.modelCount, 'model')} available`);
      } else {
        updateProvider(cfg.id, { lastTest: { ok: false, at: Date.now(), error: result.error } });
        toast.error(`Connection failed: ${result.error}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateProvider(cfg.id, { lastTest: { ok: false, at: Date.now(), error: message } });
      toast.error(`Connection failed: ${message}`);
    } finally {
      setBusy(null);
    }
  };

  const startEdit = (cfg: AiLabProviderConfig) =>
    setEditing({ id: cfg.id, label: cfg.label, baseUrl: cfg.baseUrl ?? '', apiKey: '' });

  const startCapabilityEdit = (cfg: AiLabProviderConfig, model: string) => {
    const resolved = capabilitiesForDesktopModel(cfg, model).capabilities;
    setCapabilityEditing({
      providerId: cfg.id,
      model,
      draft: {
        ...resolved,
        inputModalities: [...resolved.inputModalities],
        outputModalities: [...resolved.outputModalities],
        serverTools: [...resolved.serverTools],
      },
      assertionConfirmed: false,
    });
  };

  const saveCapabilityOverride = (cfg: AiLabProviderConfig) => {
    if (
      !capabilityEditing ||
      capabilityEditing.providerId !== cfg.id ||
      !capabilityEditing.assertionConfirmed
    )
      return;
    updateProvider(cfg.id, {
      capabilityOverrides: {
        ...cfg.capabilityOverrides,
        [capabilityEditing.model]: capabilityEditing.draft,
      },
    });
    setCapabilityEditing(null);
  };

  const resetCapabilityOverride = (cfg: AiLabProviderConfig, model: string) => {
    const next = { ...cfg.capabilityOverrides };
    delete next[model];
    updateProvider(cfg.id, {
      capabilityOverrides: Object.keys(next).length ? next : undefined,
    });
    setCapabilityEditing(null);
  };

  const setCapabilityBoolean = (
    key: (typeof BOOLEAN_CAPABILITIES)[number]['key'],
    checked: boolean
  ) =>
    setCapabilityEditing((current) => {
      if (!current) return current;
      return {
        ...current,
        draft: {
          ...current.draft,
          [key]: checked,
          ...(key === 'toolCalling' && !checked ? { parallelToolCalls: false } : {}),
        },
      };
    });

  const toggleCapabilityModality = (
    direction: 'inputModalities' | 'outputModalities',
    modality: Exclude<Modality, 'text'>,
    checked: boolean
  ) =>
    setCapabilityEditing((current) => {
      if (!current) return current;
      const modalities = current.draft[direction];
      return {
        ...current,
        draft: {
          ...current.draft,
          [direction]: checked
            ? [...new Set([...modalities, modality])]
            : modalities.filter((candidate) => candidate !== modality),
        },
      };
    });

  const saveEdit = async (cfg: AiLabProviderConfig) => {
    if (!editing || editing.id !== cfg.id || !editing.label.trim()) return;
    setEditSaving(true);
    try {
      const patch: Partial<AiLabProviderConfig> = {
        label: editing.label.trim(),
        baseUrl: editing.baseUrl.trim() || undefined,
      };
      if (editing.apiKey.trim()) {
        const secrets = getElectronAPI()?.secrets;
        if (!secrets) {
          toast.error('API keys can only be updated in the desktop app.');
          return;
        }
        const replacement = await replaceSecretHandle(
          {
            value: editing.apiKey.trim(),
            label: `${editing.label.trim()} key`,
            ...(cfg.apiKeyHandleId ? { oldHandleId: cfg.apiKeyHandleId } : {}),
          },
          {
            storeSecret: secrets.store,
            deleteSecret: secrets.delete,
            commitHandle: (handleId) =>
              updateProvider(cfg.id, { ...patch, apiKeyHandleId: handleId }),
          }
        );
        if (!replacement.ok) {
          toast.error(`Could not update the API key: ${replacement.error}`);
          return;
        }
        if (replacement.cleanupWarning) toast.warning(replacement.cleanupWarning);
      } else {
        updateProvider(cfg.id, patch);
      }
      setEditing(null);
      toast.success(`Updated ${editing.label.trim()}`);
    } finally {
      setEditSaving(false);
    }
  };

  const handleRemove = async (cfg: AiLabProviderConfig) => {
    setRemoving(cfg);
    if (!(await confirmRemove())) {
      setRemoving(null);
      return;
    }
    if (cfg.apiKeyHandleId) {
      const secrets = getElectronAPI()?.secrets;
      if (!secrets) {
        toast.error('The provider key can only be removed in the desktop app.');
        setRemoving(null);
        return;
      }
      const cleanup = await deleteSecretHandle(secrets.delete, cfg.apiKeyHandleId);
      if (!cleanup.ok) {
        toast.error(`Could not remove the provider key: ${cleanup.error}`);
        setRemoving(null);
        return;
      }
    }
    removeProvider(cfg.id);
    setRemoving(null);
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(300px,360px)_minmax(0,1fr)] max-[1000px]:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-auto border-r border-sp-line bg-sp-surface-lo p-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sp-13 font-semibold text-sp-text">Connections</h2>
            <p className="text-sp-10 text-sp-muted">
              {plural(providerList.length, 'provider')} · {plural(modelOptions.length, 'model')}
            </p>
          </div>
          <Button
            variant={showAdd ? 'ghost' : 'outline'}
            size="sm"
            onClick={() => setShowAdd(!showAdd)}
          >
            {showAdd ? <ChevronUp className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            {showAdd ? 'Hide' : 'Connect'}
          </Button>
        </div>

        {showAdd && (
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
              <Select
                value={provider}
                onValueChange={(value) => onProviderChange(value as Provider)}
              >
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
                API key {requiresApiKey(provider) ? '' : '(optional)'}
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
                      : requiresApiKey(provider)
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
        )}

        <div className="space-y-2">
          {providerList.length === 0 && !showAdd && (
            <button
              className="w-full border border-dashed border-sp-line p-5 text-center hover:bg-sp-hover"
              onClick={() => setShowAdd(true)}
            >
              <Server className="mx-auto h-6 w-6 text-sp-dim" />
              <span className="mt-2 block text-sp-12 text-sp-text">
                Connect your first provider
              </span>
            </button>
          )}
          {providerList.map((cfg) => {
            const isEditing = editing?.id === cfg.id;
            const connected = cfg.lastTest?.ok;
            return (
              <Floater key={cfg.id} radius="panel" elevation="inset" className="bg-sp-surface p-3">
                <div className="flex items-start gap-2">
                  <span
                    className={cn(
                      'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                      connected === true
                        ? 'bg-emerald-500'
                        : connected === false
                          ? 'bg-destructive'
                          : 'bg-sp-dim'
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <h3 className="truncate text-sp-12 font-medium text-sp-text">{cfg.label}</h3>
                      {cfg.isLocal && <Badge variant="success">local</Badge>}
                      {cfg.apiKeyHandleId && (
                        <KeyRound className="h-3 w-3 text-sp-muted" aria-label="Key stored" />
                      )}
                    </div>
                    <p
                      className="mt-0.5 truncate text-sp-10 text-sp-muted"
                      title={effectiveBaseUrl(cfg)}
                    >
                      {effectiveBaseUrl(cfg)}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 text-sp-10 text-sp-muted">
                      <span>{plural(cfg.models.length, 'model')}</span>
                      {cfg.lastDiscoveredAt && (
                        <span>updated {formatRelativeTime(cfg.lastDiscoveredAt)}</span>
                      )}
                    </div>
                    {cfg.lastTest && !cfg.lastTest.ok && (
                      <p
                        className="mt-1 line-clamp-2 text-sp-10 text-destructive"
                        title={cfg.lastTest.error}
                      >
                        {cfg.lastTest.error ?? 'Connection failed'}
                      </p>
                    )}
                  </div>
                </div>

                <div className="mt-2 grid grid-cols-2 gap-1 border-t border-sp-line pt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy?.id === cfg.id}
                    onClick={() => void test(cfg)}
                  >
                    {busy?.id === cfg.id && busy.action === 'test' ? (
                      <RefreshCw className="h-3 w-3 animate-spin" />
                    ) : connected ? (
                      <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                    ) : (
                      <XCircle className="h-3 w-3" />
                    )}
                    Test
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy?.id === cfg.id}
                    onClick={() => void discover(cfg)}
                  >
                    <RefreshCw
                      className={cn(
                        'h-3 w-3',
                        busy?.id === cfg.id && busy.action === 'discover' && 'animate-spin'
                      )}
                    />
                    Refresh
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => (isEditing ? setEditing(null) : startEdit(cfg))}
                  >
                    <Pencil className="h-3 w-3" /> Edit
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void handleRemove(cfg)}>
                    <Trash2 className="h-3 w-3 text-destructive" /> Remove
                  </Button>
                </div>

                {cfg.models.length > 0 && (
                  <div className="mt-2 space-y-1.5 border-t border-sp-line pt-2">
                    <div className="flex items-center gap-1.5 text-sp-10 font-medium text-sp-muted">
                      <SlidersHorizontal className="h-3 w-3" /> Advanced model capabilities
                    </div>
                    {cfg.models.map((model) => {
                      const asserted = cfg.capabilityOverrides?.[model] !== undefined;
                      const editorOpen =
                        capabilityEditing?.providerId === cfg.id &&
                        capabilityEditing.model === model;
                      return (
                        <div key={model} className="rounded border border-sp-line p-2">
                          <div className="flex items-center justify-between gap-2">
                            <span
                              className="min-w-0 truncate text-sp-10 text-sp-text"
                              title={model}
                            >
                              {cfg.modelDetails?.[model]?.label ?? model}
                            </span>
                            <div className="flex shrink-0 items-center gap-1.5">
                              {asserted && <Badge variant="warning">user asserted</Badge>}
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`Configure ${model} capabilities`}
                                onClick={() =>
                                  editorOpen
                                    ? setCapabilityEditing(null)
                                    : startCapabilityEdit(cfg, model)
                                }
                              >
                                Configure
                              </Button>
                            </div>
                          </div>

                          {editorOpen && capabilityEditing && (
                            <div className="mt-2 space-y-3 border-t border-sp-line pt-2">
                              <p className="text-sp-10 text-sp-muted">
                                Starts from discovered metadata, or the conservative text-only
                                default when discovery did not verify a feature.
                              </p>
                              <div className="grid gap-2 sm:grid-cols-2">
                                {BOOLEAN_CAPABILITIES.map(({ key, label }) => {
                                  const id = `cap-${cfg.id}-${model}-${key}`;
                                  return (
                                    <label
                                      key={key}
                                      htmlFor={id}
                                      className="flex items-center gap-2 text-sp-10 text-sp-text"
                                    >
                                      <Checkbox
                                        id={id}
                                        checked={capabilityEditing.draft[key]}
                                        disabled={
                                          key === 'parallelToolCalls' &&
                                          !capabilityEditing.draft.toolCalling
                                        }
                                        onCheckedChange={(value) =>
                                          setCapabilityBoolean(key, value === true)
                                        }
                                      />
                                      {label}
                                    </label>
                                  );
                                })}
                              </div>
                              {(['inputModalities', 'outputModalities'] as const).map(
                                (direction) => (
                                  <fieldset key={direction} className="space-y-1.5">
                                    <legend className="text-sp-10 font-medium text-sp-muted">
                                      {direction === 'inputModalities'
                                        ? 'Additional input modalities'
                                        : 'Additional output modalities'}
                                    </legend>
                                    <div className="flex flex-wrap gap-3">
                                      {OPTIONAL_MODALITIES.map(({ value, label }) => {
                                        const id = `cap-${cfg.id}-${model}-${direction}-${value}`;
                                        return (
                                          <label
                                            key={value}
                                            htmlFor={id}
                                            className="flex items-center gap-2 text-sp-10 text-sp-text"
                                          >
                                            <Checkbox
                                              id={id}
                                              checked={capabilityEditing.draft[direction].includes(
                                                value
                                              )}
                                              onCheckedChange={(checked) =>
                                                toggleCapabilityModality(
                                                  direction,
                                                  value,
                                                  checked === true
                                                )
                                              }
                                            />
                                            {label}
                                          </label>
                                        );
                                      })}
                                    </div>
                                  </fieldset>
                                )
                              )}
                              <label
                                htmlFor={`cap-${cfg.id}-${model}-assertion`}
                                className="flex items-start gap-2 text-sp-10 text-sp-text"
                              >
                                <Checkbox
                                  id={`cap-${cfg.id}-${model}-assertion`}
                                  aria-label="I am asserting this model supports these features"
                                  checked={capabilityEditing.assertionConfirmed}
                                  onCheckedChange={(checked) =>
                                    setCapabilityEditing((current) =>
                                      current
                                        ? { ...current, assertionConfirmed: checked === true }
                                        : current
                                    )
                                  }
                                />
                                <span>I am asserting this model supports these features</span>
                              </label>
                              <div className="flex flex-wrap gap-1">
                                <Button
                                  size="sm"
                                  aria-label="Save capability override"
                                  disabled={!capabilityEditing.assertionConfirmed}
                                  onClick={() => saveCapabilityOverride(cfg)}
                                >
                                  Save override
                                </Button>
                                {asserted && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => resetCapabilityOverride(cfg, model)}
                                  >
                                    Reset to discovered defaults
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  aria-label="Close capability editor"
                                  onClick={() => setCapabilityEditing(null)}
                                >
                                  Close
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {isEditing && editing && (
                  <div className="mt-2 space-y-2 border-t border-sp-line pt-2">
                    <Input
                      value={editing.label}
                      aria-label="Provider name"
                      onChange={(event) => setEditing({ ...editing, label: event.target.value })}
                    />
                    <Input
                      value={editing.baseUrl}
                      aria-label="Provider base URL"
                      placeholder={DEFAULT_BASE[cfg.provider] || 'https://…'}
                      onChange={(event) => setEditing({ ...editing, baseUrl: event.target.value })}
                    />
                    <Input
                      type="password"
                      value={editing.apiKey}
                      aria-label="Replace API key"
                      placeholder={
                        cfg.apiKeyHandleId ? 'Leave blank to keep current key' : 'New API key'
                      }
                      onChange={(event) => setEditing({ ...editing, apiKey: event.target.value })}
                    />
                    <div className="flex gap-1">
                      <Button size="sm" disabled={editSaving} onClick={() => void saveEdit(cfg)}>
                        {editSaving ? 'Saving…' : 'Save changes'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </Floater>
            );
          })}
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-col bg-sp-bg">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-sp-line px-4 py-3">
          <div>
            <h2 className="text-sp-13 font-semibold text-sp-text">Model catalog</h2>
            <p className="mt-0.5 text-sp-10 text-sp-muted">
              Search every discovered model. Favorites and recent models appear first in run
              pickers.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-sp-10 text-sp-muted">
            <span>{plural(favoriteModelKeys.length, 'favorite')}</span>
            <span>·</span>
            <span>{plural(modelOptions.length, 'model')}</span>
          </div>
        </div>
        <ModelCatalog
          options={modelOptions}
          favoriteKeys={favoriteSet}
          onToggleFavorite={toggleFavoriteModel}
        />
      </section>
      <RemoveProviderDialog />
    </div>
  );
}
