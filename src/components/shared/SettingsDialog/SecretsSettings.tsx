import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Trash2, KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { isElectron, getElectronAPI } from '@/lib/shared/platform';
import { DesktopOnlyBadge } from '@/components/shared/DesktopOnlyBadge';

interface HandleSummary {
  id: string;
  label?: string;
  scope?: string;
  createdAt: number;
}

/**
 * Settings panel for SecretRef handles (ADR-0007). Lists every handle stored
 * in the OS-keychain-backed secret store and lets the user delete unused ones.
 * Plaintext is never read — `secret:resolve` is intentionally not exposed.
 */
export function SecretsSettings() {
  const electron = isElectron();
  const [handles, setHandles] = useState<HandleSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!electron) return;
    const api = getElectronAPI();
    if (!api?.secrets?.list) return;
    setLoading(true);
    try {
      const result = await api.secrets.list();
      if (result.ok) {
        setHandles(result.handles);
      } else {
        toast.error(`Failed to load handles: ${result.error}`);
      }
    } finally {
      setLoading(false);
    }
  }, [electron]);

  useEffect(() => {
    refresh();
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
    refresh();
  };

  if (!electron) {
    return (
      <div>
        <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-3">
          Stored Secrets
        </p>
        <DesktopOnlyBadge title="Secret storage requires the Restura desktop app — the browser has no OS keychain." />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-3">
          Stored Secrets
        </p>
        <p className="text-xs text-muted-foreground mb-3">
          Plaintext for these handles lives in the OS keychain. Restura never reads them in the renderer;
          the main process resolves them at the wire boundary only when a request is sent.
        </p>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground font-mono">Loading…</p>
      ) : handles.length === 0 ? (
        <div className="rounded border border-border bg-muted/30 p-4 text-xs text-muted-foreground">
          No stored secrets yet. Use the &ldquo;Store&rdquo; button next to a password field in any
          auth configuration to create a handle.
        </div>
      ) : (
        <ul className="rounded border border-border divide-y divide-border">
          {handles.map((h) => (
            <li key={h.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <KeyRound className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden />
                <div className="min-w-0">
                  <p className="text-xs font-mono truncate">{h.label || h.id.slice(0, 8) + '…'}</p>
                  <p className="text-[10px] text-muted-foreground font-mono">
                    {new Date(h.createdAt).toLocaleString()}
                    {h.scope ? ` · scope: ${h.scope}` : ''}
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleDelete(h.id)}
                title="Delete this handle"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
