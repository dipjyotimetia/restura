import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { Lock, KeyRound } from 'lucide-react';
import { cn } from '@/lib/shared/utils';
import { isElectron, getElectronAPI } from '@/lib/shared/platform';
import {
  describeSecret,
  isSecretHandle,
  type SecretValue,
} from '@/lib/shared/secretRef';

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
}: SecretInputProps) {
  const electron = isElectron();
  const [handles, setHandles] = useState<HandleSummary[]>([]);
  const inlineValue = typeof value === 'string' ? value : value?.kind === 'inline' ? value.value : '';

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
    const args = storageLabel ? { value: inlineValue, label: storageLabel } : { value: inlineValue };
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

  if (isSecretHandle(value)) {
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden />
        <Input value={describeSecret(value)} readOnly disabled className="font-mono text-xs" />
        {!disabled && (
          <Button type="button" variant="outline" size="sm" onClick={() => onChange({ kind: 'inline', value: '' })}>
            Replace
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Input
        type="password"
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
        </>
      )}
    </div>
  );
}
