import { ChevronUp, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { getElectronAPI } from '@/lib/shared/platform';
import { listModels, testConnection } from '../lib/llmClient';
import { buildModelOptions } from '../lib/modelOptions';
import { plural } from '../lib/plural';
import {
  connectAndAddProvider,
  deleteSecretHandle,
  type ProviderConnectionDraft,
  replaceSecretHandle,
  splitDiscoveredModels,
} from '../lib/providerConnection';
import { effectiveProviderBaseUrl } from '../lib/providerPolicy';
import { useAiLabStore } from '../store/useAiLabStore';
import type { AiLabProviderConfig } from '../types';
import { ModelCatalog } from './ModelCatalog';
import { ProviderCatalog } from './ProviderCatalog';
import { ConnectProviderEditor, type ProviderCredentialDraft } from './ProviderCredentialEditor';

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
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState<{ id: string; action: 'test' | 'discover' } | null>(null);
  const [removing, setRemoving] = useState<AiLabProviderConfig | null>(null);

  const { confirm: confirmRemove, DialogComponent: RemoveProviderDialog } = useConfirmDialog({
    title: 'Remove provider',
    description: removing
      ? `Remove “${removing.label}”? Its keychain secret and model catalog will also be removed.`
      : '',
    confirmText: 'Remove provider',
    variant: 'destructive',
  });

  const connect = async (draft: ProviderConnectionDraft): Promise<boolean> => {
    const electron = getElectronAPI();
    if (!electron) {
      toast.error('Provider setup is only available in the desktop app.');
      return false;
    }
    setConnecting(true);
    try {
      const result = await connectAndAddProvider(draft, {
        storeSecret: electron.secrets.store,
        deleteSecret: electron.secrets.delete,
        discoverModels: listModels,
        addProvider,
      });
      if (!result.ok) {
        toast.error(`Could not connect: ${result.error}`);
        return false;
      }
      toast.success(`Connected ${draft.label} with ${plural(result.modelCount, 'model')}`);
      setShowAdd(false);
      return true;
    } finally {
      setConnecting(false);
    }
  };

  const discover = async (config: AiLabProviderConfig) => {
    setBusy({ id: config.id, action: 'discover' });
    try {
      const result = await listModels({
        provider: config.provider,
        baseUrl: effectiveProviderBaseUrl(config),
        ...(config.apiKeyHandleId ? { apiKeyHandleId: config.apiKeyHandleId } : {}),
      });
      if (!result.ok) {
        updateProvider(config.id, { lastTest: { ok: false, at: Date.now(), error: result.error } });
        toast.error(`Catalog refresh failed: ${result.error}`);
        return;
      }
      const { models, modelDetails } = splitDiscoveredModels(result.models);
      setProviderModels(config.id, models, modelDetails);
      updateProvider(config.id, {
        lastTest: { ok: true, at: Date.now(), modelCount: models.length },
      });
      toast.success(`Refreshed ${config.label}: ${plural(models.length, 'model')}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateProvider(config.id, { lastTest: { ok: false, at: Date.now(), error: message } });
      toast.error(`Catalog refresh failed: ${message}`);
    } finally {
      setBusy(null);
    }
  };

  const test = async (config: AiLabProviderConfig) => {
    setBusy({ id: config.id, action: 'test' });
    try {
      const result = await testConnection({
        provider: config.provider,
        baseUrl: effectiveProviderBaseUrl(config),
        ...(config.apiKeyHandleId ? { apiKeyHandleId: config.apiKeyHandleId } : {}),
      });
      if (result.ok) {
        updateProvider(config.id, {
          lastTest: { ok: true, at: Date.now(), modelCount: result.modelCount },
        });
        toast.success(`Connected — ${plural(result.modelCount, 'model')} available`);
      } else {
        updateProvider(config.id, { lastTest: { ok: false, at: Date.now(), error: result.error } });
        toast.error(`Connection failed: ${result.error}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateProvider(config.id, { lastTest: { ok: false, at: Date.now(), error: message } });
      toast.error(`Connection failed: ${message}`);
    } finally {
      setBusy(null);
    }
  };

  const saveCredentials = async (
    config: AiLabProviderConfig,
    draft: ProviderCredentialDraft
  ): Promise<boolean> => {
    if (!draft.label.trim()) return false;
    const patch: Partial<AiLabProviderConfig> = {
      label: draft.label.trim(),
      baseUrl: draft.baseUrl.trim() || undefined,
    };
    if (draft.apiKey.trim()) {
      const secrets = getElectronAPI()?.secrets;
      if (!secrets) {
        toast.error('API keys can only be updated in the desktop app.');
        return false;
      }
      const replacement = await replaceSecretHandle(
        {
          value: draft.apiKey.trim(),
          label: `${draft.label.trim()} key`,
          ...(config.apiKeyHandleId ? { oldHandleId: config.apiKeyHandleId } : {}),
        },
        {
          storeSecret: secrets.store,
          deleteSecret: secrets.delete,
          commitHandle: (handleId) =>
            updateProvider(config.id, { ...patch, apiKeyHandleId: handleId }),
        }
      );
      if (!replacement.ok) {
        toast.error(`Could not update the API key: ${replacement.error}`);
        return false;
      }
      if (replacement.cleanupWarning) toast.warning(replacement.cleanupWarning);
    } else {
      updateProvider(config.id, patch);
    }
    toast.success(`Updated ${draft.label.trim()}`);
    return true;
  };

  const handleRemove = async (config: AiLabProviderConfig) => {
    setRemoving(config);
    if (!(await confirmRemove())) {
      setRemoving(null);
      return;
    }
    if (config.apiKeyHandleId) {
      const secrets = getElectronAPI()?.secrets;
      if (!secrets) {
        toast.error('The provider key can only be removed in the desktop app.');
        setRemoving(null);
        return;
      }
      const cleanup = await deleteSecretHandle(secrets.delete, config.apiKeyHandleId);
      if (!cleanup.ok) {
        toast.error(`Could not remove the provider key: ${cleanup.error}`);
        setRemoving(null);
        return;
      }
    }
    removeProvider(config.id);
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

        {showAdd && <ConnectProviderEditor connecting={connecting} onConnect={connect} />}
        <ProviderCatalog
          providers={providerList}
          busy={busy}
          onTest={(config) => void test(config)}
          onDiscover={(config) => void discover(config)}
          onRemove={(config) => void handleRemove(config)}
          onRequestConnect={() => setShowAdd(true)}
          onSaveCredentials={saveCredentials}
          onUpdateProvider={updateProvider}
        />
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
