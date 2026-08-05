import { Cloud, KeyRound, Lock } from 'lucide-react';
import { useState } from 'react';
import type { ExternalSecretProfile } from '@shared/secrets/external-secret-profile';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import {
  describeSecret,
  isExternalSecretRef,
  isSecretHandle,
  type SecretValue,
} from '@/lib/shared/secretRef';
import { cn } from '@/lib/shared/utils';

interface HandleSummary {
  id: string;
  label?: string;
  scope?: string;
  createdAt: number;
}

interface SecretInputProps {
  value: SecretValue | undefined;
  onChange: (next: SecretValue) => void;
  placeholder?: string;
  className?: string;
  /**
   * Human-readable label used when storing a new handle (`<requestName> / <field>`).
   * Surfaces in the Settings → Secrets panel and the handle dropdown.
   */
  storageLabel?: string;
  disabled?: boolean;
  /** Forwarded to the inline text input so an external <label htmlFor> can target it. */
  id?: string;
}

/**
 * Per-descriptor SecretRef input (ADR-0007). Renders password-style input
 * bound to a `SecretValue`. On desktop the user can switch between inline
 * plaintext and an opaque handle stored in the OS keychain. Web is
 * inline-only — the stored-mode controls are hidden.
 */
export default function SecretInput({
  value,
  onChange,
  placeholder,
  className,
  storageLabel,
  disabled,
  id,
}: SecretInputProps) {
  const electron = isElectron();
  const [handles, setHandles] = useState<HandleSummary[]>([]);
  const [profiles, setProfiles] = useState<ExternalSecretProfile[]>([]);
  const [showExternal, setShowExternal] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [secretId, setSecretId] = useState('');
  const [selector, setSelector] = useState('');
  const [label, setLabel] = useState('');
  const inlineValue =
    typeof value === 'string' ? value : value?.kind === 'inline' ? value.value : '';

  const refreshHandles = async () => {
    if (!electron) return;
    const api = getElectronAPI();
    if (!api?.secrets?.list) return;
    const result = await api.secrets.list();
    if (result.ok) {
      setHandles(result.handles);
    }
  };

  const storeAsHandle = async () => {
    const api = getElectronAPI();
    if (!electron || !api?.secrets?.store) {
      toast.error('Secret storage is not available on this platform');
      return;
    }
    if (!inlineValue) {
      toast.error('Enter a value before storing');
      return;
    }
    const args = storageLabel
      ? { value: inlineValue, label: storageLabel }
      : { value: inlineValue };
    const result = await api.secrets.store(args);
    if (!result.ok) {
      toast.error(`Failed to store secret: ${result.error}`);
      return;
    }
    onChange({ kind: 'handle', id: result.id, ...(storageLabel ? { label: storageLabel } : {}) });
    toast.success('Secret stored securely');
    refreshHandles();
  };

  const pickExistingHandle = (id: string) => {
    const summary = handles.find((h) => h.id === id);
    if (!summary) return;
    onChange({ kind: 'handle', id, ...(summary.label ? { label: summary.label } : {}) });
  };

  const refreshProfiles = async () => {
    const api = getElectronAPI();
    if (!electron || !api?.externalSecrets) return;
    const result = await api.externalSecrets.list();
    setProfiles(result.profiles);
  };

  const useExternalReference = () => {
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (!profile || !secretId.trim()) {
      toast.error('Choose a profile and enter a secret identifier');
      return;
    }
    onChange({
      kind: 'external',
      provider: profile.provider,
      profileId: profile.id,
      secretId: secretId.trim(),
      ...(selector.trim() ? { selector: selector.trim() } : {}),
      ...(label.trim() ? { label: label.trim() } : {}),
    });
    setShowExternal(false);
  };

  if (isSecretHandle(value)) {
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden />
        <Input value={describeSecret(value)} readOnly disabled className="font-mono text-xs" />
        {!disabled && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange({ kind: 'inline', value: '' })}
          >
            Replace
          </Button>
        )}
      </div>
    );
  }

  if (isExternalSecretRef(value)) {
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <Cloud className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden />
        <Input value={describeSecret(value)} readOnly disabled className="font-mono text-xs" />
        {!disabled && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setShowExternal(true);
              void refreshProfiles();
            }}
          >
            Replace
          </Button>
        )}
        {showExternal && renderExternalReferenceForm()}
      </div>
    );
  }

  function renderExternalReferenceForm() {
    return (
      <div className="flex flex-wrap items-center gap-2 w-full rounded-md border p-2">
        <Select
          value={profileId}
          onOpenChange={(open) => {
            if (open) void refreshProfiles();
          }}
          onValueChange={setProfileId}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="External profile…" />
          </SelectTrigger>
          <SelectContent>
            {profiles.length === 0 ? (
              <SelectItem value="__empty__" disabled>
                (configure one in Settings)
              </SelectItem>
            ) : (
              profiles.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  {profile.label || profile.provider}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
        <Input
          value={secretId}
          onChange={(event) => setSecretId(event.target.value)}
          placeholder="Secret name"
          className="w-[160px]"
        />
        <Input
          value={selector}
          onChange={(event) => setSelector(event.target.value)}
          placeholder="Version / stage (optional)"
          className="w-[190px]"
        />
        <Input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Display label (optional)"
          className="w-[180px]"
        />
        <Button type="button" variant="outline" size="sm" onClick={useExternalReference}>
          Use external secret
        </Button>
      </div>
    );
  }

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Input
        type="password"
        id={id}
        value={inlineValue}
        onChange={(e) => onChange({ kind: 'inline', value: e.target.value })}
        placeholder={placeholder}
        disabled={disabled}
      />
      {electron && (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={storeAsHandle}
            disabled={disabled || !inlineValue}
            title="Store this value in the OS keychain and reference by handle"
          >
            <KeyRound className="h-3.5 w-3.5 mr-1" />
            Store
          </Button>
          <Select
            onOpenChange={(open) => {
              if (open) refreshHandles();
            }}
            onValueChange={pickExistingHandle}
          >
            <SelectTrigger className="w-[140px]" disabled={disabled}>
              <SelectValue placeholder="Use handle…" />
            </SelectTrigger>
            <SelectContent>
              {handles.length === 0 ? (
                <SelectItem value="__empty__" disabled>
                  (no stored handles)
                </SelectItem>
              ) : (
                handles.map((h) => (
                  <SelectItem key={h.id} value={h.id}>
                    {h.label || h.id.slice(0, 8) + '…'}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setShowExternal((current) => !current);
              void refreshProfiles();
            }}
            disabled={disabled}
            title="Reference a secret held by a configured cloud provider"
          >
            <Cloud className="h-3.5 w-3.5 mr-1" />
            External
          </Button>
        </>
      )}
      {electron && showExternal && renderExternalReferenceForm()}
    </div>
  );
}
