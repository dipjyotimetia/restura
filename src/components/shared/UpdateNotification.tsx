import { useEffect, useRef, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { Download, RefreshCw, RotateCw } from 'lucide-react';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_AUTO_UPDATE_SETTINGS } from '@/types';
import type { UpdaterStatus } from '../../../electron/types/electron-api';

/**
 * In-app auto-updater UI for the Electron desktop app. Subscribes to the
 * main-process status stream (window.electron.updater.onStatus) and renders a
 * seamless sticky banner per state — replacing the old blocking native dialogs.
 * Also keeps the main-process updater config in sync with user settings and
 * services the tray's "Check for Updates" menu item. Renders nothing on web.
 */
export function UpdateNotification(): ReactElement | null {
  const [status, setStatus] = useState<UpdaterStatus>({ state: 'idle' });
  const [dismissed, setDismissed] = useState(false);
  const prevState = useRef<UpdaterStatus['state']>('idle');
  const autoUpdate = useSettingsStore((s) => s.settings.autoUpdate) ?? DEFAULT_AUTO_UPDATE_SETTINGS;

  // Subscribe to status pushes + wire the tray menu's check action.
  useEffect(() => {
    if (!isElectron()) return;
    const api = getElectronAPI();
    if (!api) return;
    const unsubscribe = api.updater.onStatus((next) => {
      // A failed *automatic* check (offline at startup / on the 6h tick) is
      // noise — stay silent. Only a failure that interrupts an in-progress
      // download the user is watching is worth surfacing; user-initiated
      // checks get their own feedback via the tray toast below.
      const wasDownloading = prevState.current === 'downloading';
      prevState.current = next.state;
      setStatus(next);
      setDismissed(false); // a fresh push is worth showing again
      if (next.state === 'error' && wasDownloading) {
        toast.error('Update download failed', { description: next.message });
      }
    });
    // Tray "Check for Updates" is a user action, so give it transient feedback
    // (Checking… → up-to-date / available) rather than dropping the result.
    const onTrayCheck = () => {
      void toast.promise(api.updater.check(), {
        loading: 'Checking for updates…',
        success: (res) =>
          res.error
            ? `Update check failed`
            : res.updateAvailable
              ? `Update available${res.version ? ` — v${res.version}` : ''}`
              : "You're up to date",
        error: 'Update check failed',
      });
    };
    api.on('app:check-updates', onTrayCheck);
    return () => {
      unsubscribe();
      api.removeListener('app:check-updates', onTrayCheck);
    };
  }, []);

  // Keep the main-process updater aligned with the user's preferences.
  useEffect(() => {
    if (!isElectron()) return;
    const api = getElectronAPI();
    if (!api) return;
    void api.updater.setConfig(autoUpdate);
  }, [autoUpdate]);

  if (!isElectron() || dismissed) return null;

  const api = getElectronAPI();
  if (!api) return null;

  // Only the actionable positive states get a persistent banner. checking /
  // not-available are transient and silent; errors surface as toasts (above),
  // never a sticky bar the user must dismiss every background check.
  if (
    status.state !== 'available' &&
    status.state !== 'downloading' &&
    status.state !== 'downloaded'
  ) {
    return null;
  }

  // `available` with auto-download on resolves to `downloading` almost
  // immediately, so show a neutral "preparing" line; with it off, offer the
  // explicit Download action.
  return (
    <div
      role="status"
      aria-live="polite"
      className="glass-1 glass-border-default sticky top-0 z-50 border-b border-sky-500/40 bg-sky-950/40 px-4 py-2 text-sm text-sky-100"
    >
      <div className="mx-auto flex max-w-7xl items-center gap-3">
        {status.state === 'available' && (
          <>
            <Download className="h-4 w-4 shrink-0 text-sky-400" aria-hidden />
            <div className="flex-1 min-w-0">
              <span className="font-medium">Update available</span>
              {status.version && <span className="ml-1 text-sky-200/90">v{status.version}</span>}
              {autoUpdate.autoDownload && (
                <span className="ml-2 text-xs text-sky-200/70">Preparing download…</span>
              )}
            </div>
            {!autoUpdate.autoDownload && (
              <button
                type="button"
                onClick={() => void api.updater.download()}
                className="inline-flex items-center gap-1.5 rounded-md border border-sky-400/40 px-2.5 py-1 text-xs font-medium text-sky-100 transition hover:bg-sky-400/10"
              >
                <Download className="h-3 w-3" aria-hidden />
                Download
              </button>
            )}
          </>
        )}

        {status.state === 'downloading' && (
          <>
            <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-sky-400" aria-hidden />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">
                  Downloading update{status.version ? ` v${status.version}` : ''}
                </span>
                <span className="text-xs tabular-nums text-sky-200/80">
                  {Math.round(status.percent ?? 0)}%
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-sky-500/20">
                <div
                  className="h-full rounded-full bg-sky-400 transition-[width] duration-300"
                  style={{ width: `${Math.round(status.percent ?? 0)}%` }}
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => void api.updater.cancel()}
              className="inline-flex items-center gap-1.5 rounded-md border border-sky-400/40 px-2.5 py-1 text-xs font-medium text-sky-100 transition hover:bg-sky-400/10"
            >
              Cancel
            </button>
          </>
        )}

        {status.state === 'downloaded' && (
          <>
            <RotateCw className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
            <div className="flex-1 min-w-0">
              <span className="font-medium">
                Update{status.version ? ` v${status.version}` : ''} ready
              </span>
              <span className="ml-2 text-xs text-sky-200/70">Restart to apply.</span>
            </div>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="rounded-md px-2.5 py-1 text-xs font-medium text-sky-200/80 transition hover:bg-sky-400/10"
            >
              Later
            </button>
            <button
              type="button"
              onClick={() => void api.updater.restart()}
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-400/50 bg-emerald-400/10 px-2.5 py-1 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-400/20"
            >
              <RotateCw className="h-3 w-3" aria-hidden />
              Restart now
            </button>
          </>
        )}
      </div>
    </div>
  );
}
