import { Info, KeyRound, ShieldAlert, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DesktopOnlyBadge } from '@/components/shared/DesktopOnlyBadge';
import { Floater, ToggleField } from '@/components/ui/spatial';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { cn } from '@/lib/shared/utils';
import { useSettingsStore } from '@/store/useSettingsStore';
import {
  FieldGroup,
  FieldRow,
  SectionHeader,
  SectionLabel,
} from '../components/SettingsSectionPrimitives';

export function SecuritySection() {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  return (
    <>
      <SectionHeader
        icon={ShieldAlert}
        title="Security"
        description="Control which hosts Restura is allowed to reach."
      />
      <FieldGroup label="Outbound targets">
        <FieldRow
          label="Allow localhost"
          hint="Permit requests to localhost, 127.0.0.1, and ::1. Turn off to block loopback targets."
          control={
            <ToggleField
              checked={settings.allowLocalhost ?? true}
              onChange={(value) => updateSettings({ allowLocalhost: value })}
              ariaLabel="Allow localhost"
            />
          }
        />
        <FieldRow
          label="Allow private / internal IPs"
          hint="Permit RFC-1918 (10.x, 172.16.x, 192.168.x), CGNAT, and link-local targets. Cloud-metadata endpoints stay blocked. Leave off unless you need to reach internal hosts."
          control={
            <ToggleField
              checked={settings.allowPrivateIPs === true}
              onChange={(value) => updateSettings({ allowPrivateIPs: value })}
              ariaLabel="Allow private and internal IP addresses"
            />
          }
        />
      </FieldGroup>
      <p className="text-sp-11-5 text-sp-muted mt-4 flex items-start gap-1.5">
        <Info size={13} className="shrink-0 mt-0.5 text-sp-accent" aria-hidden="true" />
        <span>
          On the desktop app these govern Restura&rsquo;s HTTP, WebSocket, SSE, Socket.IO, gRPC, and
          MCP requests. In the browser they gate an in-app pre-check only — the hosted web app and
          self-host server enforce their own network policy, which always takes precedence.
          Cloud-metadata endpoints (e.g. <span className="font-mono">169.254.169.254</span>) are
          blocked on every platform, regardless of these settings. Kafka and MQTT brokers follow
          protocol-appropriate rules — private/LAN broker addresses stay reachable (cloud-metadata
          is still blocked) — so these two toggles don&rsquo;t restrict them.
        </span>
      </p>
    </>
  );
}

interface SecretHandleSummary {
  id: string;
  label?: string;
  scope?: string;
  createdAt: number;
}

export function SecretsSection() {
  const electron = isElectron();
  const [handles, setHandles] = useState<SecretHandleSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    if (!electron) return;
    const api = getElectronAPI();
    if (!api?.secrets?.list) return;
    setLoading(true);
    try {
      const result = await api.secrets.list();
      if (result.ok) setHandles(result.handles);
      else toast.error(`Failed to load handles: ${result.error}`);
    } finally {
      setLoading(false);
    }
  }, [electron]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleDelete = async (id: string) => {
    const api = getElectronAPI();
    if (!api?.secrets?.delete) return;
    const result = await api.secrets.delete(id);
    if (!result.ok) {
      toast.error(`Failed to delete: ${result.error}`);
      return;
    }
    toast.success('Secret deleted');
    void refresh();
  };

  if (!electron) {
    return (
      <SectionHeader
        icon={KeyRound}
        title="Secrets"
        description={
          <>
            Tokens and keys referenced from your collections.
            <DesktopOnlyBadge title="Secret storage requires the Restura desktop app — the browser has no OS keychain." />
          </>
        }
      />
    );
  }

  return (
    <>
      <SectionHeader
        icon={KeyRound}
        title="Secrets"
        description="Plaintext for these handles lives in the OS keychain. Restura never reads them in the renderer; the main process resolves them at the wire boundary only when a request is sent."
      />
      <SectionLabel>Stored handles</SectionLabel>
      {loading ? (
        <Floater radius="panel" elevation="inset" className="p-4">
          <p className="text-sp-12 text-sp-muted font-mono">Loading…</p>
        </Floater>
      ) : handles.length === 0 ? (
        <Floater radius="panel" elevation="inset" className="p-5">
          <p className="text-sp-13 text-sp-muted">
            No stored secrets yet. Use the &ldquo;Store&rdquo; button next to a password field in
            any auth configuration to create a handle.
          </p>
        </Floater>
      ) : (
        <Floater radius="panel" elevation="inset" className="overflow-hidden">
          <ul className="divide-y divide-sp-line">
            {handles.map((handle) => (
              <li key={handle.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <KeyRound className="h-3.5 w-3.5 text-sp-muted shrink-0" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="text-sp-12 font-mono text-sp-text truncate">
                      {handle.label || handle.id.slice(0, 8) + '…'}
                    </p>
                    <p className="text-sp-11 text-sp-muted font-mono">
                      {new Date(handle.createdAt).toLocaleString()}
                      {handle.scope ? ` · scope: ${handle.scope}` : ''}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleDelete(handle.id)}
                  aria-label={`Delete handle ${handle.label || handle.id}`}
                  title="Delete this handle"
                  className={cn(
                    'inline-flex items-center justify-center w-7 h-7 rounded-sp-btn shrink-0',
                    'text-sp-muted hover:text-rose-400 hover:bg-sp-hover transition-colors',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
                  )}
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        </Floater>
      )}
    </>
  );
}
