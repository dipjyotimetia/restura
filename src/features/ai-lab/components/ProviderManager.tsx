import type { DiscoveredModel } from '@shared/protocol/ai/model-discovery';
import { isLocalProvider, type Provider } from '@shared/protocol/ai/types';
import { Download, KeyRound, Pencil, Server, Trash2, Wifi, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { listModels, testConnection } from '../lib/llmClient';
import { plural } from '../lib/plural';
import { useAiLabStore } from '../store/useAiLabStore';
import type { AiLabModelDetail, AiLabProviderConfig } from '../types';
import { EmptyState } from './EmptyState';
import { useConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
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
import { formatRelativeTime } from '@/lib/shared/console-format';
import { getElectronAPI } from '@/lib/shared/platform';

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

/**
 * Split a discovery response into the plain id list (always persisted) and
 * the optional per-model metadata map (only populated when the discovery
 * endpoint returned rich fields). Reduces a wire shape to the two store
 * fields we own.
 *
 * Only fields that are present (and not the default for that key) are copied
 * forward — avoids storing a `vendor: 'anthropic'` for every Anthropic model
 * when the user might never look at the chip, but more importantly keeps the
 * persisted blob small and forward-compatible.
 */
function splitDiscoveredModels(models: DiscoveredModel[]): {
  models: string[];
  modelDetails: Record<string, AiLabModelDetail>;
} {
  const ids: string[] = [];
  const details: Record<string, AiLabModelDetail> = {};
  for (const m of models) {
    if (typeof m.id !== 'string' || m.id.length === 0) continue;
    ids.push(m.id);
    const detail: AiLabModelDetail = {};
    if (m.label) detail.label = m.label;
    if (m.description) detail.description = m.description;
    if (typeof m.contextLength === 'number' && m.contextLength > 0) {
      detail.contextLength = m.contextLength;
    }
    if (m.modality) detail.modality = m.modality;
    if (m.createdAt) detail.createdAt = m.createdAt;
    if (m.vendor) detail.vendor = m.vendor;
    if (m.family) detail.family = m.family;
    if (m.parameterSize) detail.parameterSize = m.parameterSize;
    if (m.quantizationLevel) detail.quantizationLevel = m.quantizationLevel;
    if (m.modifiedAt) detail.modifiedAt = m.modifiedAt;
    if (typeof m.sizeBytes === 'number' && m.sizeBytes >= 0) {
      detail.sizeBytes = m.sizeBytes;
    }
    if (m.pricing) {
      const p: { promptPerMTokUSD?: number; completionPerMTokUSD?: number } = {};
      if (typeof m.pricing.promptPerMTokUSD === 'number') {
        p.promptPerMTokUSD = m.pricing.promptPerMTokUSD;
      }
      if (typeof m.pricing.completionPerMTokUSD === 'number') {
        p.completionPerMTokUSD = m.pricing.completionPerMTokUSD;
      }
      if (Object.keys(p).length > 0) detail.pricing = p;
    }
    if (Object.keys(detail).length > 0) details[m.id] = detail;
  }
  return { models: ids, modelDetails: details };
}

export function ProviderManager() {
  const providers = useAiLabStore((s) => s.providers);
  const addProvider = useAiLabStore((s) => s.addProvider);
  const updateProvider = useAiLabStore((s) => s.updateProvider);
  const removeProvider = useAiLabStore((s) => s.removeProvider);
  const setProviderModels = useAiLabStore((s) => s.setProviderModels);

  const [provider, setProvider] = useState<Provider>('ollama');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('http://localhost:11434');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<{ id: string; action: 'test' | 'discover' } | null>(null);
  // Tracks "fetching the public OpenRouter catalog" so the add-form's
  // Download button can show its own spinner. The `discover` action above
  // uses a per-config `busy` keyed by id; this one is form-scoped and
  // exists in parallel so adding a provider can race with discovery.
  const [publicFetchBusy, setPublicFetchBusy] = useState(false);
  // Tagged with the provider it was fetched for so a stale catalog can never
  // attach to a different provider type — even if a fetch resolves after the
  // user has already switched the type selector.
  const [prefetchedCatalog, setPrefetchedCatalog] = useState<{
    provider: Provider;
    modelIds: string[];
    modelDetails: Record<string, AiLabModelDetail>;
  } | null>(null);
  const stagedCatalog =
    prefetchedCatalog && prefetchedCatalog.provider === provider ? prefetchedCatalog : null;
  const [removing, setRemoving] = useState<AiLabProviderConfig | null>(null);
  // Inline edit state for an existing provider card (null = not editing).
  // Only one card edits at a time, so the in-flight flag is a plain boolean
  // beside it rather than a field threaded through every setEditing call.
  const [editing, setEditing] = useState<{
    id: string;
    label: string;
    baseUrl: string;
    /** New API key; blank = keep the current one. */
    apiKey: string;
  } | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const { confirm: confirmRemove, DialogComponent: RemoveProviderDialog } = useConfirmDialog({
    title: 'Remove provider',
    description: removing
      ? `Remove "${removing.label}"? Its stored API key is deleted from the OS keychain and any Playground/Eval/Arena config referencing it will need a new provider.`
      : '',
    confirmText: 'Remove',
    variant: 'destructive',
  });

  const opt = PROVIDER_OPTIONS.find((o) => o.value === provider)!;

  const onProviderChange = (v: Provider) => {
    setProvider(v);
    setBaseUrl(DEFAULT_BASE[v]);
    // Staged catalog is provider-specific; switching types makes it
    // meaningless so drop it (the provider tag guards against races, this
    // just frees the memory eagerly).
    setPrefetchedCatalog(null);
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
    // Capture the pre-fetched catalog (if any, and only if it was fetched
    // for the currently selected provider type) so it travels with the
    // provider entry — otherwise the user would have to re-discover
    // immediately after adding the provider just to populate the checklist.
    const prefetched = stagedCatalog;
    const id = addProvider({
      provider,
      label: label.trim(),
      ...(opt.needsBaseUrl || baseUrl ? { baseUrl: baseUrl.trim() } : {}),
      ...(apiKeyHandleId ? { apiKeyHandleId } : {}),
      ...(prefetched ? { models: prefetched.modelIds } : {}),
    });
    if (prefetched && Object.keys(prefetched.modelDetails).length > 0) {
      // Apply the rich per-model metadata as a second pass so the store's
      // narrow add-provider signature stays simple; the catalog is already
      // associated with the new id.
      setProviderModels(id, prefetched.modelIds, prefetched.modelDetails);
    }
    setLabel('');
    setApiKey('');
    setPrefetchedCatalog(null);
    if (prefetched) {
      toast.success(
        `Added ${label.trim()} with ${plural(prefetched.modelIds.length, 'pre-fetched model')}`
      );
    } else {
      toast.success(`Added ${label.trim()}`);
    }
  };

  /**
   * Pull the full OpenRouter model catalog from the public API WITHOUT a key.
   * The result is staged in component state and consumed by `add()` so the
   * provider is born with its model list — the user doesn't have to click
   * "Discover" again. The API key field stays optional; a bare provider
   * config can still be used once the user pastes their key later (the
   * subsequent inference calls will go through with auth).
   *
   * Also runs for already-added OpenRouter providers — the existing
   * `discover(cfg)` covers that path with the stored key handle (if any).
   */
  const fetchOpenRouterPublicCatalog = async () => {
    setPublicFetchBusy(true);
    try {
      const res = await listModels({
        provider: 'openrouter',
        baseUrl: DEFAULT_BASE.openrouter,
        // Deliberately no apiKeyHandleId — exercises the unauthenticated
        // public endpoint. OpenRouter rate-limits anonymous callers; for
        // heavy use the user can still paste a key into the field above and
        // re-discover through `discover()` after adding.
      });
      if (!res.ok) {
        toast.error(`Public catalog fetch failed: ${res.error}`);
        return;
      }
      const { models, modelDetails } = splitDiscoveredModels(res.models);
      setPrefetchedCatalog({ provider: 'openrouter', modelIds: models, modelDetails });
      toast.success(`Fetched ${plural(models.length, 'model')} from OpenRouter's public API`);
    } finally {
      setPublicFetchBusy(false);
    }
  };

  /**
   * Pull the model list for the currently selected provider using whatever
   * credentials/baseUrl the user has entered in the form. Stages the result
   * in component state so the next `add()` call attaches them. Each provider
   * has different requirements (keyless vs. key-required) — the button is
   * only shown when the current input satisfies the requirement, and the
   * helper message reflects what we still need.
   */
  const canFetchForCurrentSelection = (): { ok: boolean; reason?: string } => {
    switch (provider) {
      case 'openai':
        return apiKey.trim()
          ? { ok: true }
          : { ok: false, reason: 'Enter an OpenAI API key to fetch its model catalog.' };
      case 'anthropic':
        return apiKey.trim()
          ? { ok: true }
          : { ok: false, reason: 'Enter an Anthropic API key to fetch its model catalog.' };
      case 'openrouter':
        // OpenRouter's public catalog is keyless; the openrouter-only button
        // above handles the "no key yet" case so the generic affordance can
        // require a key here.
        return apiKey.trim()
          ? { ok: true }
          : { ok: false, reason: 'Use “Fetch catalog” above for the public OpenRouter catalog.' };
      case 'ollama':
        return baseUrl.trim()
          ? { ok: true }
          : { ok: false, reason: 'Enter a base URL to fetch Ollama’s model list.' };
      case 'openai-compatible':
        return baseUrl.trim()
          ? { ok: true }
          : { ok: false, reason: 'Enter a base URL to fetch the gateway’s model list.' };
    }
  };

  const fetchCatalogForCurrentSelection = async () => {
    const gate = canFetchForCurrentSelection();
    if (!gate.ok) {
      toast.error(gate.reason ?? 'Missing configuration.');
      return;
    }
    // Snapshot the selection so the staged result is tagged with the provider
    // the fetch was actually issued for, even if the user flips the type
    // selector while the request is in flight.
    const forProvider = provider;
    setPublicFetchBusy(true);
    try {
      const effectiveBase =
        (opt.needsBaseUrl || isLocalProvider(forProvider)) && baseUrl.trim()
          ? baseUrl.trim()
          : DEFAULT_BASE[forProvider];
      const res = await listModels({
        provider: forProvider,
        baseUrl: effectiveBase,
        // The add-form's API key is a plaintext local field, not a handle
        // (we mint a handle in `add()` only if the user commits the form).
        // Discovery can run on this short-lived key — it never touches the
        // wire in a way the renderer couldn't see itself, and the key is
        // not persisted to disk until the user clicks "Add provider".
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      if (!res.ok) {
        toast.error(`Catalog fetch failed: ${res.error}`);
        return;
      }
      const { models, modelDetails } = splitDiscoveredModels(res.models);
      setPrefetchedCatalog({ provider: forProvider, modelIds: models, modelDetails });
      const detailCount = Object.keys(modelDetails).length;
      const suffix = detailCount > 0 ? ` (${detailCount} with metadata)` : '';
      toast.success(
        `Fetched ${plural(models.length, 'model')} for ${PROVIDER_OPTIONS.find((o) => o.value === forProvider)?.label ?? forProvider}${suffix}`
      );
    } finally {
      setPublicFetchBusy(false);
    }
  };

  const discover = async (cfg: AiLabProviderConfig) => {
    setBusy({ id: cfg.id, action: 'discover' });
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
      const { models, modelDetails } = splitDiscoveredModels(res.models);
      setProviderModels(cfg.id, models, modelDetails);
      const detailCount = Object.keys(modelDetails).length;
      const detailSuffix = detailCount > 0 ? ` (${detailCount} with full metadata)` : '';
      toast.success(`Found ${plural(models.length, 'model')}${detailSuffix}`);
    } finally {
      setBusy(null);
    }
  };

  const test = async (cfg: AiLabProviderConfig) => {
    setBusy({ id: cfg.id, action: 'test' });
    try {
      const res = await testConnection({
        provider: cfg.provider,
        baseUrl: effectiveBaseUrl(cfg),
        ...(cfg.apiKeyHandleId ? { apiKeyHandleId: cfg.apiKeyHandleId } : {}),
      });
      // Persist the outcome so the card shows a durable "tested ✓ Nm ago"
      // instead of only a transient toast.
      if (res.ok) {
        updateProvider(cfg.id, {
          lastTest: { ok: true, at: Date.now(), modelCount: res.modelCount },
        });
        toast.success(`Connected — ${plural(res.modelCount, 'model')} available`);
      } else {
        updateProvider(cfg.id, { lastTest: { ok: false, at: Date.now(), error: res.error } });
        toast.error(`Connection failed: ${res.error}`);
      }
    } finally {
      setBusy(null);
    }
  };

  const startEdit = (cfg: AiLabProviderConfig) =>
    setEditing({ id: cfg.id, label: cfg.label, baseUrl: cfg.baseUrl ?? '', apiKey: '' });

  /**
   * Save an inline edit. A non-blank API key rotates the stored secret:
   * mint the new keychain handle first, then delete the old one, so a
   * mid-flight failure can't leave the provider pointing at a dead handle.
   */
  const saveEdit = async (cfg: AiLabProviderConfig) => {
    if (!editing || editing.id !== cfg.id) return;
    if (!editing.label.trim()) {
      toast.error('Provider name cannot be empty.');
      return;
    }
    setEditSaving(true);
    try {
      const patch: Partial<AiLabProviderConfig> = { label: editing.label.trim() };
      const nextBase = editing.baseUrl.trim();
      if (nextBase !== (cfg.baseUrl ?? '')) {
        // Clearing the field falls back to the provider's default base URL.
        patch.baseUrl = nextBase || undefined;
      }
      if (editing.apiKey.trim()) {
        const secrets = getElectronAPI()?.secrets;
        const res = await secrets?.store({
          scope: 'ai-lab',
          value: editing.apiKey.trim(),
          label: `${editing.label.trim()} key`,
        });
        if (!res?.ok) {
          toast.error('Failed to store the new API key — nothing was changed.');
          return;
        }
        if (cfg.apiKeyHandleId) await secrets?.delete(cfg.apiKeyHandleId);
        patch.apiKeyHandleId = res.id;
      }
      updateProvider(cfg.id, patch);
      setEditing(null);
      toast.success(`Updated ${editing.label.trim()}`);
    } finally {
      setEditSaving(false);
    }
  };

  // Delete the keychain-backed secret handle BEFORE dropping the provider
  // config — otherwise the handle is orphaned in the secret-handle-store
  // forever (removeProvider only touches Zustand state).
  const handleRemoveClick = async (cfg: AiLabProviderConfig) => {
    setRemoving(cfg);
    if (!(await confirmRemove())) return;
    if (cfg.apiKeyHandleId) {
      await getElectronAPI()?.secrets.delete(cfg.apiKeyHandleId);
    }
    removeProvider(cfg.id);
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
        <Floater radius="panel" elevation="float" className="space-y-3 bg-sp-surface p-4">
          <h2 className="text-sp-13 font-semibold text-sp-text">Add a provider</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ailab-provider-type" className="sp-label">
                Type
              </Label>
              <Select value={provider} onValueChange={(v) => onProviderChange(v as Provider)}>
                <SelectTrigger id="ailab-provider-type">
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
              <Label htmlFor="ailab-provider-name" className="sp-label">
                Name
              </Label>
              <Input
                id="ailab-provider-name"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Local Ollama"
              />
            </div>
            {(opt.needsBaseUrl || isLocalProvider(provider)) && (
              <div className="space-y-1.5">
                <Label htmlFor="ailab-provider-baseurl" className="sp-label">
                  Base URL
                </Label>
                <Input
                  id="ailab-provider-baseurl"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="http://localhost:11434"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="ailab-provider-apikey" className="sp-label">
                API key {isLocalProvider(provider) ? '(optional)' : ''}
              </Label>
              <Input
                id="ailab-provider-apikey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={isLocalProvider(provider) ? 'usually not required' : 'sk-…'}
              />
            </div>
          </div>
          {(() => {
            // The catalog-fetch affordance adapts to the selected provider:
            //   * OpenRouter — pull from the public (keyless) catalog
            //   * Ollama / OpenAI-compatible — pull from the user-typed base URL
            //   * OpenAI / Anthropic — pull with the user-typed key
            // The same staged-models-on-add UX applies for every variant.
            const gate = canFetchForCurrentSelection();
            const supportsPublic = provider === 'openrouter';
            const supportsKeyed = gate.ok;
            if (!supportsPublic && !supportsKeyed && !apiKey.trim() && !baseUrl.trim()) {
              return null;
            }
            const description = supportsPublic
              ? provider === 'openrouter'
                ? 'Auto-fetch the full OpenRouter catalog from their public API (no key required). Staged models are attached when you add the provider, so it’s ready to run immediately.'
                : (gate.reason ?? '')
              : (gate.reason ??
                `Pull the model list for ${
                  PROVIDER_OPTIONS.find((o) => o.value === provider)?.label ?? provider
                } and stage it for this provider.`);
            return (
              <div className="flex flex-wrap items-center gap-2 rounded-sp-btn border border-sp-line bg-sp-surface-2 px-3 py-2 text-sp-12 text-sp-muted">
                <Download
                  className={`h-3.5 w-3.5 text-sp-accent ${publicFetchBusy ? 'animate-pulse' : ''}`}
                />
                <span className="min-w-0 flex-1">{description}</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={publicFetchBusy || (!supportsPublic && !supportsKeyed)}
                  onClick={() =>
                    void (supportsPublic && !apiKey.trim()
                      ? fetchOpenRouterPublicCatalog()
                      : fetchCatalogForCurrentSelection())
                  }
                >
                  {publicFetchBusy
                    ? 'Fetching…'
                    : stagedCatalog
                      ? `Re-fetch (${stagedCatalog.modelIds.length} staged)`
                      : 'Fetch catalog'}
                </Button>
              </div>
            );
          })()}
          <Button onClick={() => void add()} variant="cta" size="cta">
            Add provider
          </Button>
        </Floater>

        <section className="space-y-2">
          <h2 className="text-sp-13 font-semibold text-sp-text">Providers</h2>
          {Object.values(providers).length === 0 && (
            <EmptyState icon={Server} message="No providers yet. Add one above." />
          )}
          {Object.values(providers).map((cfg) => {
            const isEditing = editing?.id === cfg.id;
            return (
              <Floater key={cfg.id} radius="panel" elevation="inset" className="space-y-3 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sp-13 font-medium text-sp-text">
                        {cfg.label}
                      </span>
                      <Badge variant="mono" className="shrink-0">
                        {cfg.provider}
                      </Badge>
                      {cfg.isLocal && (
                        <Badge variant="success" className="shrink-0">
                          local
                        </Badge>
                      )}
                      {cfg.apiKeyHandleId && (
                        <Badge
                          variant="mono"
                          className="shrink-0 gap-1"
                          title="An API key is stored in the OS keychain for this provider"
                        >
                          <KeyRound className="h-2.5 w-2.5" aria-hidden /> key
                        </Badge>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-sp-12 text-sp-muted">
                      {effectiveBaseUrl(cfg)} · {plural(cfg.models.length, 'model')}
                      {cfg.modelDetails &&
                        Object.keys(cfg.modelDetails).length > 0 &&
                        ` · ${Object.keys(cfg.modelDetails).length} with metadata`}
                      {!cfg.pricingKnown && ' · cost unknown'}
                    </div>
                    {cfg.lastTest && (
                      <div
                        className={`mt-0.5 truncate text-sp-11 ${
                          cfg.lastTest.ok ? 'text-emerald-500' : 'text-destructive'
                        }`}
                        title={cfg.lastTest.error}
                      >
                        {cfg.lastTest.ok
                          ? `✓ connected ${formatRelativeTime(cfg.lastTest.at)}`
                          : `✗ connection failed ${formatRelativeTime(cfg.lastTest.at)}`}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Test connection"
                      title="Test connection"
                      disabled={busy?.id === cfg.id}
                      onClick={() => void test(cfg)}
                    >
                      <Wifi
                        className={`h-3.5 w-3.5 ${busy?.id === cfg.id && busy.action === 'test' ? 'animate-pulse' : ''}`}
                      />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Discover models"
                      title="Discover models"
                      disabled={busy?.id === cfg.id}
                      onClick={() => void discover(cfg)}
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${busy?.id === cfg.id && busy.action === 'discover' ? 'animate-spin' : ''}`}
                      />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Edit provider"
                      title="Edit provider"
                      onClick={() => (isEditing ? setEditing(null) : startEdit(cfg))}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Remove provider"
                      title="Remove provider"
                      onClick={() => void handleRemoveClick(cfg)}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>
                {isEditing && editing && (
                  <div className="space-y-3 border-t border-sp-line pt-3">
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor={`edit-label-${cfg.id}`} className="sp-label">
                          Name
                        </Label>
                        <Input
                          id={`edit-label-${cfg.id}`}
                          value={editing.label}
                          onChange={(e) => setEditing({ ...editing, label: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`edit-baseurl-${cfg.id}`} className="sp-label">
                          Base URL
                        </Label>
                        <Input
                          id={`edit-baseurl-${cfg.id}`}
                          value={editing.baseUrl}
                          onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
                          placeholder={DEFAULT_BASE[cfg.provider] || 'https://…'}
                        />
                      </div>
                      <div className="space-y-1.5 md:col-span-2">
                        <Label htmlFor={`edit-apikey-${cfg.id}`} className="sp-label">
                          {cfg.apiKeyHandleId ? 'Replace API key' : 'API key'}
                        </Label>
                        <Input
                          id={`edit-apikey-${cfg.id}`}
                          type="password"
                          value={editing.apiKey}
                          onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
                          placeholder={
                            cfg.apiKeyHandleId ? 'leave blank to keep the current key' : 'sk-…'
                          }
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button size="sm" disabled={editSaving} onClick={() => void saveEdit(cfg)}>
                        {editSaving ? 'Saving…' : 'Save changes'}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </Floater>
            );
          })}
        </section>
      </div>

      <RemoveProviderDialog />
    </div>
  );
}
