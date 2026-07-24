import { CheckCircle2, KeyRound, Pencil, RefreshCw, Server, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Floater } from '@/components/ui/spatial';
import { formatRelativeTime } from '@/lib/shared/console-format';
import { cn } from '@/lib/shared/utils';
import { plural } from '../lib/plural';
import { effectiveProviderBaseUrl } from '../lib/providerPolicy';
import type { AiLabProviderConfig } from '../types';
import { CapabilityOverrides } from './CapabilityOverrides';
import { EditProviderCredentials, type ProviderCredentialDraft } from './ProviderCredentialEditor';

interface ProviderCatalogProps {
  providers: AiLabProviderConfig[];
  busy: { id: string; action: 'test' | 'discover' } | null;
  onDiscover: (config: AiLabProviderConfig) => void;
  onRemove: (config: AiLabProviderConfig) => void;
  onRequestConnect: () => void;
  onSaveCredentials: (
    config: AiLabProviderConfig,
    draft: ProviderCredentialDraft
  ) => Promise<boolean>;
  onTest: (config: AiLabProviderConfig) => void;
  onUpdateProvider: (id: string, patch: Partial<AiLabProviderConfig>) => void;
}

export function ProviderCatalog({
  providers,
  busy,
  onDiscover,
  onRemove,
  onRequestConnect,
  onSaveCredentials,
  onTest,
  onUpdateProvider,
}: ProviderCatalogProps) {
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [savingCredentials, setSavingCredentials] = useState(false);

  const saveCredentials = async (config: AiLabProviderConfig, draft: ProviderCredentialDraft) => {
    setSavingCredentials(true);
    try {
      if (await onSaveCredentials(config, draft)) setEditingProviderId(null);
    } finally {
      setSavingCredentials(false);
    }
  };

  return (
    <div className="space-y-2">
      {providers.length === 0 && (
        <button
          type="button"
          className="w-full border border-dashed border-sp-line p-5 text-center hover:bg-sp-hover"
          onClick={onRequestConnect}
        >
          <Server className="mx-auto h-6 w-6 text-sp-dim" />
          <span className="mt-2 block text-sp-12 text-sp-text">Connect your first provider</span>
        </button>
      )}
      {providers.map((config) => {
        const isEditing = editingProviderId === config.id;
        const connected = config.lastTest?.ok;
        return (
          <Floater key={config.id} radius="panel" elevation="inset" className="bg-sp-surface p-3">
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
                  <h3 className="truncate text-sp-12 font-medium text-sp-text">{config.label}</h3>
                  {config.isLocal && <Badge variant="success">local</Badge>}
                  {config.apiKeyHandleId && (
                    <KeyRound className="h-3 w-3 text-sp-muted" aria-label="Key stored" />
                  )}
                </div>
                <p
                  className="mt-0.5 truncate text-sp-10 text-sp-muted"
                  title={effectiveProviderBaseUrl(config)}
                >
                  {effectiveProviderBaseUrl(config)}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 text-sp-10 text-sp-muted">
                  <span>{plural(config.models.length, 'model')}</span>
                  {config.lastDiscoveredAt && (
                    <span>updated {formatRelativeTime(config.lastDiscoveredAt)}</span>
                  )}
                </div>
                {config.lastTest && !config.lastTest.ok && (
                  <p
                    className="mt-1 line-clamp-2 text-sp-10 text-destructive"
                    title={config.lastTest.error}
                  >
                    {config.lastTest.error ?? 'Connection failed'}
                  </p>
                )}
              </div>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-1 border-t border-sp-line pt-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy?.id === config.id}
                onClick={() => onTest(config)}
              >
                {busy?.id === config.id && busy.action === 'test' ? (
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
                disabled={busy?.id === config.id}
                onClick={() => onDiscover(config)}
              >
                <RefreshCw
                  className={cn(
                    'h-3 w-3',
                    busy?.id === config.id && busy.action === 'discover' && 'animate-spin'
                  )}
                />
                Refresh
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditingProviderId(isEditing ? null : config.id)}
              >
                <Pencil className="h-3 w-3" /> Edit
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onRemove(config)}>
                <Trash2 className="h-3 w-3 text-destructive" /> Remove
              </Button>
            </div>

            <CapabilityOverrides config={config} onUpdateProvider={onUpdateProvider} />

            {isEditing && (
              <EditProviderCredentials
                key={config.id}
                config={config}
                saving={savingCredentials}
                onSave={(draft) => void saveCredentials(config, draft)}
                onCancel={() => setEditingProviderId(null)}
              />
            )}
          </Floater>
        );
      })}
    </div>
  );
}
