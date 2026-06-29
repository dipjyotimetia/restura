/**
 * Settings card: start/stop the browser-capture desktop bridge and surface the
 * pairing code the user pastes into the Restura capture extension. Desktop-only
 * (the bridge binds a loopback listener the web build can't). The token is shown
 * only here, in the trusted renderer, and never travels over the HTTP surface.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';

export function CaptureBridgeCard() {
  const [running, setRunning] = useState(false);
  const [port, setPort] = useState<number | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const res = await getElectronAPI()?.capture.bridgeStatus();
    if (res?.ok) {
      setRunning(res.status.running);
      setPort(res.status.port ?? null);
    }
  }, []);

  useEffect(() => {
    if (isElectron()) void refresh();
  }, [refresh]);

  const start = async () => {
    setBusy(true);
    try {
      const res = await getElectronAPI()?.capture.startBridge();
      if (res?.ok) {
        setRunning(true);
        setPort(res.status.port ?? null);
        setToken(res.token ?? null);
      } else {
        toast.error('Could not start capture bridge', { description: res?.error });
      }
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await getElectronAPI()?.capture.stopBridge();
      setRunning(false);
      setToken(null);
      setPort(null);
    } finally {
      setBusy(false);
    }
  };

  if (!isElectron()) return null;

  const pairingCode = port != null && token ? `${port}:${token}` : null;

  return (
    <section className="rounded-lg border border-sp-line p-4">
      <h3 className="text-sm font-medium">Browser capture bridge</h3>
      <p className="mt-1 text-xs text-sp-muted">
        Pair the Restura capture extension to import captured browser traffic. Start the bridge,
        then paste the pairing code into the extension's options page.
      </p>

      <div className="mt-3 flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          loading={busy}
          onClick={() => void (running ? stop() : start())}
        >
          {running ? 'Stop bridge' : 'Start bridge'}
        </Button>
        <span className="text-xs text-sp-muted">
          {running ? `Listening on 127.0.0.1:${port ?? '…'}` : 'Stopped'}
        </span>
      </div>

      {pairingCode && (
        <div className="mt-3">
          <span className="text-xs text-sp-muted">Pairing code (one-time)</span>
          <div className="mt-1 flex items-center gap-2">
            <code className="flex-1 truncate rounded-md bg-sp-surface-hi px-2 py-1 font-mono text-xs">
              {pairingCode}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(pairingCode);
                toast.success('Pairing code copied');
              }}
            >
              Copy
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
