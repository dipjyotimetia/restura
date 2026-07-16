import { AlertTriangle, Download, ExternalLink, RefreshCw, RotateCw } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_AUTO_UPDATE_SETTINGS } from '@/types';
import type { UpdaterStatus } from '../../../electron/types/electron-api';

const MANUAL_DOWNLOAD_URL = 'https://github.com/dipjyotimetia/restura/releases/latest';

function updaterErrorTitle(status: UpdaterStatus): string {
  switch (status.phase) {
    case 'download':
      return 'Update download failed';
    case 'validation':
      return 'Update verification failed';
    case 'install':
      return 'Update installation failed';
    default:
      return 'Update failed';
  }
}

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
  const autoUpdate = useSettingsStore((s) => s.settings.autoUpdate) ?? DEFAULT_AUTO_UPDATE_SETTINGS;

  // Subscribe to status pushes + wire the tray menu's check action.
  useEffect(() => {
    if (!isElectron()) return;
    const api = getElectronAPI();
    if (!api) return;
    const applyStatus = (next: UpdaterStatus) => {
      setStatus(next);
      setDismissed(false); // a fresh push is worth showing again
      // Automatic background checks remain quiet. Failures after an update is
      // discovered are active operations and stay visible until recovery.
      if (next.state === 'error' && next.phase && next.phase !== 'check') {
        toast.error(updaterErrorTitle(next), { description: next.message });
      }
    };
    let receivedPush = false;
    const unsubscribe = api.updater.onStatus((next) => {
      receivedPush = true;
      applyStatus(next);
    });
    // Subscribe first, then read the main-process snapshot. This closes the
    // launch/reload race without allowing an older snapshot to overwrite a
    // state that arrived over the live event stream.
    void api.updater
      .getStatus()
      .then((next) => {
        if (!receivedPush) applyStatus(next);
      })
      .catch(() => undefined);
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

  const visibleError = status.state === 'error' && status.phase && status.phase !== 'check';

  // Background checks remain transient and silent. Download, validation, and
  // installation failures stay visible because the user must be able to
  // recover without finding the main-process log.
  if (
    status.state !== 'available' &&
    status.state !== 'downloading' &&
    status.state !== 'validating' &&
    status.state !== 'downloaded' &&
    status.state !== 'installing' &&
    !visibleError
  ) {
    return null;
  }

  // `available` with auto-download on resolves to `downloading` almost
  // immediately, so show a neutral "preparing" line; with it off, offer the
  // explicit Download action.
  return (
    <div
      role={visibleError ? 'alert' : 'status'}
      aria-live="polite"
      className={`sticky top-0 z-50 border-b px-4 py-2 text-sm ${
        visibleError
          ? 'border-red-500/40 bg-red-500/10 text-red-800 dark:bg-red-950/40 dark:text-red-100'
          : 'border-sky-500/40 bg-sky-500/10 text-sky-800 dark:bg-sky-950/40 dark:text-sky-100'
      }`}
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
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event('restura:open-release-notes'))}
              className="rounded-md px-2.5 py-1 text-xs font-medium text-sky-200/80 transition hover:bg-sky-400/10"
            >
              What's new
            </button>
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

        {status.state === 'validating' && (
          <>
            <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-sky-400" aria-hidden />
            <div className="flex-1 min-w-0">
              <span className="font-medium">Verifying update…</span>
              <span className="ml-2 text-xs text-sky-200/70">
                Checking the downloaded app before restart.
              </span>
            </div>
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

        {status.state === 'installing' && (
          <>
            <RotateCw className="h-4 w-4 shrink-0 animate-spin text-emerald-400" aria-hidden />
            <div className="flex-1 min-w-0">
              <span className="font-medium">Restarting to install…</span>
              <span className="ml-2 text-xs text-sky-200/70">Restura will reopen shortly.</span>
            </div>
          </>
        )}

        {visibleError && status.state === 'error' && (
          <>
            <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" aria-hidden />
            <div className="flex-1 min-w-0">
              <div className="font-medium">{updaterErrorTitle(status)}</div>
              <div className="text-xs text-red-700/80 dark:text-red-200/80">{status.message}</div>
            </div>
            <button
              type="button"
              onClick={() => void api.updater.check()}
              className="inline-flex items-center gap-1.5 rounded-md border border-red-400/40 px-2.5 py-1 text-xs font-medium transition hover:bg-red-400/10"
            >
              <RefreshCw className="h-3 w-3" aria-hidden />
              Retry
            </button>
            <button
              type="button"
              onClick={() => void api.shell.openExternal(MANUAL_DOWNLOAD_URL)}
              className="inline-flex items-center gap-1.5 rounded-md border border-red-400/40 px-2.5 py-1 text-xs font-medium transition hover:bg-red-400/10"
            >
              <ExternalLink className="h-3 w-3" aria-hidden />
              Manual download
            </button>
          </>
        )}
      </div>
    </div>
  );
}
