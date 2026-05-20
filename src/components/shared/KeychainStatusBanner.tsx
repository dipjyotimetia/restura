import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { AlertTriangle, RefreshCw, ShieldOff } from 'lucide-react';
import { getElectronAPI, isElectron, getPlatform } from '@/lib/shared/platform';
import type { KeychainStatus } from '../../../electron/types/electron.d';

function installHint(platform: ReturnType<typeof getPlatform>): string {
  if (platform === 'linux') {
    return 'Install gnome-keyring (GNOME), kwallet (KDE), or libsecret-1-0 to enable OS-keychain encryption.';
  }
  if (platform === 'win32') {
    return 'Windows DPAPI is missing — this usually indicates a corrupted user profile. Try signing out and back in.';
  }
  return 'macOS Keychain should always be available. Try running the app from /Applications and grant Keychain access if prompted.';
}

export function KeychainStatusBanner(): ReactElement | null {
  const [status, setStatus] = useState<KeychainStatus | null>(null);
  const [rotating, setRotating] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    const api = getElectronAPI();
    if (!api) return;
    try {
      const next = await api.keychain.status();
      setStatus(next);
    } catch {
      // IPC unavailable — banner stays hidden rather than alarming the user
      // with an error about its own status check.
    }
  }, []);

  useEffect(() => {
    if (!isElectron()) return;
    void refresh();
  }, [refresh]);

  const handleRotate = useCallback(async (): Promise<void> => {
    const api = getElectronAPI();
    if (!api) return;
    setRotating(true);
    try {
      const result = await api.keychain.rotate();
      setStatus(result.status);
    } finally {
      setRotating(false);
    }
  }, []);

  if (!isElectron() || !status || status.mode !== 'plaintext') return null;

  const platform = getPlatform();
  const reasonText =
    status.reason === 'decrypt-failed'
      ? 'A previously-encrypted key failed to decrypt — your keychain may have been reset.'
      : 'Your OS does not expose a keychain backend to Electron.';

  return (
    <div
      role="alert"
      aria-live="polite"
      className="glass-1 glass-border-default sticky top-0 z-50 border-b border-amber-500/40 bg-amber-950/40 px-4 py-2 text-sm text-amber-100"
    >
      <div className="mx-auto flex max-w-7xl items-start gap-3">
        <ShieldOff className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden />
        <div className="flex-1">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            Secrets are stored without OS-keychain protection
          </div>
          <p className="mt-1 text-xs text-amber-200/90">
            {reasonText} {installHint(platform)}
          </p>
          {status.plaintextStores.length > 0 && (
            <p className="mt-1 text-xs text-amber-200/70">
              Affected: {status.plaintextStores.join(', ')}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void handleRotate()}
          disabled={rotating}
          className="inline-flex items-center gap-1.5 rounded-md border border-amber-400/40 px-2.5 py-1 text-xs font-medium text-amber-100 transition hover:bg-amber-400/10 disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${rotating ? 'animate-spin' : ''}`} aria-hidden />
          {rotating ? 'Checking…' : 'Re-check'}
        </button>
      </div>
    </div>
  );
}
