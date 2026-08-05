import { Info, KeyRound, ShieldAlert, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type {
  ExternalSecretProfile,
  ExternalSecretProfileInput,
} from '@shared/secrets/external-secret-profile';
import { toast } from 'sonner';
import { DesktopOnlyBadge } from '@/components/shared/DesktopOnlyBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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

type Provider = ExternalSecretProfile['provider'];

export function buildExternalSecretProfileInput(
  provider: Provider,
  authKind: 'named-profile' | 'workload-identity',
  values: Record<string, string>
): ExternalSecretProfileInput | null {
  const label = values.label?.trim();
  const withLabel = label ? { label } : {};
  if (provider === 'aws-secrets-manager') {
    if (!values.region?.trim()) return null;
    return authKind === 'named-profile'
      ? {
          provider,
          region: values.region.trim(),
          auth: { kind: authKind, profile: values.profile?.trim() ?? '' },
          ...withLabel,
        }
      : {
          provider,
          region: values.region.trim(),
          auth: {
            kind: authKind,
            roleArn: values.roleArn?.trim() ?? '',
            tokenFile: values.tokenFile?.trim() ?? '',
            ...(values.sessionName?.trim() ? { sessionName: values.sessionName.trim() } : {}),
          },
          ...withLabel,
        };
  }
  if (provider === 'google-secret-manager') {
    return {
      provider,
      projectId: values.projectId?.trim() ?? '',
      auth: { kind: authKind, credentialConfigFile: values.credentialConfigFile?.trim() ?? '' },
      ...withLabel,
    };
  }
  return authKind === 'named-profile'
    ? {
        provider,
        vaultName: values.vaultName?.trim() ?? '',
        auth: {
          kind: authKind,
          ...(values.subscription?.trim() ? { subscription: values.subscription.trim() } : {}),
        },
        ...withLabel,
      }
    : {
        provider,
        vaultName: values.vaultName?.trim() ?? '',
        auth: {
          kind: authKind,
          tenantId: values.tenantId?.trim() ?? '',
          clientId: values.clientId?.trim() ?? '',
          tokenFile: values.tokenFile?.trim() ?? '',
        },
        ...withLabel,
      };
}

export function ExternalSecretProfiles() {
  const [profiles, setProfiles] = useState<ExternalSecretProfile[]>([]);
  const [provider, setProvider] = useState<Provider>('aws-secrets-manager');
  const [authKind, setAuthKind] = useState<'named-profile' | 'workload-identity'>('named-profile');
  const [editingId, setEditingId] = useState<string>();
  const [values, setValues] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const result = await getElectronAPI()?.externalSecrets?.list();
    if (result) setProfiles(result.profiles);
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const reset = () => {
    setEditingId(undefined);
    setProvider('aws-secrets-manager');
    setAuthKind('named-profile');
    setValues({});
  };
  const set = (name: string, value: string) =>
    setValues((current) => ({ ...current, [name]: value }));
  const input = (name: string, placeholder: string, required = true) => (
    <Input
      value={values[name] ?? ''}
      onChange={(event) => set(name, event.target.value)}
      placeholder={`${placeholder}${required ? ' *' : ''}`}
      className="h-8 text-xs"
    />
  );

  const save = async () => {
    const inputValue = buildExternalSecretProfileInput(provider, authKind, values);
    const api = getElectronAPI()?.externalSecrets;
    if (!api || !inputValue) {
      toast.error('Complete the required profile fields');
      return;
    }
    try {
      if (editingId) await api.update({ ...inputValue, id: editingId } as ExternalSecretProfile);
      else await api.create(inputValue);
      toast.success(editingId ? 'External profile updated' : 'External profile added');
      reset();
      await refresh();
    } catch {
      toast.error('Could not save the external profile');
    }
  };

  const edit = (profile: ExternalSecretProfile) => {
    setEditingId(profile.id);
    setProvider(profile.provider);
    setAuthKind(profile.auth.kind);
    const common = { label: profile.label ?? '' };
    if (profile.provider === 'aws-secrets-manager') {
      setValues({
        ...common,
        region: profile.region,
        ...(profile.auth.kind === 'named-profile'
          ? { profile: profile.auth.profile }
          : {
              roleArn: profile.auth.roleArn,
              tokenFile: profile.auth.tokenFile,
              sessionName: profile.auth.sessionName ?? '',
            }),
      });
    } else if (profile.provider === 'google-secret-manager') {
      setValues({
        ...common,
        projectId: profile.projectId,
        credentialConfigFile: profile.auth.credentialConfigFile,
      });
    } else {
      setValues({
        ...common,
        vaultName: profile.vaultName,
        ...(profile.auth.kind === 'named-profile'
          ? { subscription: profile.auth.subscription ?? '' }
          : {
              tenantId: profile.auth.tenantId,
              clientId: profile.auth.clientId,
              tokenFile: profile.auth.tokenFile,
            }),
      });
    }
  };

  const remove = async (id: string) => {
    try {
      await getElectronAPI()?.externalSecrets?.delete(id);
      await refresh();
      toast.success('External profile deleted');
    } catch {
      toast.error('Could not delete the external profile');
    }
  };

  return (
    <FieldGroup label="External cloud profiles">
      <p className="text-sp-11 text-sp-muted mb-2">
        Profile metadata is encrypted locally; provider credentials and resolved values never enter
        Restura.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Select value={provider} onValueChange={(value) => setProvider(value as Provider)}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="aws-secrets-manager">AWS Secrets Manager</SelectItem>
            <SelectItem value="google-secret-manager">Google Secret Manager</SelectItem>
            <SelectItem value="azure-key-vault">Azure Key Vault</SelectItem>
          </SelectContent>
        </Select>
        <Select value={authKind} onValueChange={(value) => setAuthKind(value as typeof authKind)}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="named-profile">Named profile / CLI identity</SelectItem>
            <SelectItem value="workload-identity">Workload identity</SelectItem>
          </SelectContent>
        </Select>
        {input('label', 'Profile label', false)}
        {provider === 'aws-secrets-manager' && input('region', 'AWS region')}
        {provider === 'google-secret-manager' && input('projectId', 'Google project ID')}
        {provider === 'azure-key-vault' && input('vaultName', 'Azure vault name')}
        {authKind === 'named-profile' &&
          provider === 'aws-secrets-manager' &&
          input('profile', 'AWS profile name')}
        {authKind === 'named-profile' &&
          provider === 'google-secret-manager' &&
          input('credentialConfigFile', 'Google credential config path')}
        {authKind === 'named-profile' &&
          provider === 'azure-key-vault' &&
          input('subscription', 'Azure subscription (optional)', false)}
        {authKind === 'workload-identity' && provider === 'aws-secrets-manager' && (
          <>
            {input('roleArn', 'AWS role ARN')}
            {input('tokenFile', 'Web identity token file')}
            {input('sessionName', 'Session name', false)}
          </>
        )}
        {authKind === 'workload-identity' &&
          provider === 'google-secret-manager' &&
          input('credentialConfigFile', 'Google credential config path')}
        {authKind === 'workload-identity' && provider === 'azure-key-vault' && (
          <>
            {input('tenantId', 'Azure tenant ID')}
            {input('clientId', 'Azure client ID')}
            {input('tokenFile', 'Federated token file')}
          </>
        )}
      </div>
      <div className="flex gap-2 mt-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void save()}>
          {editingId ? 'Save profile' : 'Add profile'}
        </Button>
        {editingId && (
          <Button type="button" variant="ghost" size="sm" onClick={reset}>
            Cancel
          </Button>
        )}
      </div>
      {profiles.length > 0 && (
        <ul className="mt-3 divide-y divide-sp-line rounded-sp-btn border border-sp-line">
          {profiles.map((profile) => (
            <li key={profile.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0 truncate text-sp-12 font-mono">
                {profile.label || profile.provider}
              </span>
              <span className="flex shrink-0 gap-2">
                <button
                  type="button"
                  className="text-sp-muted hover:text-sp-text text-sp-11"
                  onClick={() => edit(profile)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="text-rose-400 text-sp-11"
                  onClick={() => void remove(profile.id)}
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </FieldGroup>
  );
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
      <ExternalSecretProfiles />
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
