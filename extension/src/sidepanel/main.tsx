import { useEffect, useMemo, useState } from 'react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { CapturedProtocol } from '@shared/capture/types';
import { exportHar, exportOpenCollection } from '../lib/export-actions';
import { sendToDesktop } from '../lib/bridge-client';
import { type CaptureState } from '../lib/messages';
import { sendToWorker } from '../lib/runtime';
import { RequestList } from './RequestList';

const PROTOCOLS: (CapturedProtocol | 'all')[] = [
  'all',
  'rest',
  'graphql',
  'grpc-web',
  'websocket',
  'sse',
];

function App(): React.JSX.Element {
  const [state, setState] = useState<CaptureState | null>(null);
  const [filter, setFilter] = useState('');
  const [protocol, setProtocol] = useState<CapturedProtocol | 'all'>('all');
  const [note, setNote] = useState('');

  const refresh = async (): Promise<void> => setState(await sendToWorker({ type: 'capture:get' }));

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, []);

  const exchanges = state?.session?.exchanges ?? [];
  const filtered = useMemo(
    () =>
      exchanges.filter(
        (ex) =>
          (protocol === 'all' || ex.protocol === protocol) &&
          (filter === '' || ex.url.toLowerCase().includes(filter.toLowerCase()))
      ),
    [exchanges, filter, protocol]
  );

  const session = state?.session ?? null;
  const run = (label: string, fn: () => void | Promise<void>) => async () => {
    try {
      await fn();
      setNote(`${label} ✓`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : `${label} failed`);
    }
  };

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 12 }}>
      <h1 style={{ fontSize: 14, margin: '0 0 8px' }}>
        Restura Capture {state?.capturing ? '🔴' : ''}
      </h1>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input
          placeholder="Filter URL…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ flex: 1 }}
        />
        <select value={protocol} onChange={(e) => setProtocol(e.target.value as CapturedProtocol)}>
          {PROTOCOLS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          disabled={!session}
          onClick={run('OpenCollection exported', () => {
            if (session) exportOpenCollection(session);
          })}
        >
          Export OpenCollection
        </button>
        <button
          type="button"
          disabled={!session}
          onClick={run('HAR exported', () => {
            if (session) exportHar(session);
          })}
        >
          Export HAR
        </button>
        <button
          type="button"
          disabled={!session}
          onClick={run('Sent to desktop', async () => {
            if (session) await sendToDesktop(session);
          })}
        >
          Send to Desktop
        </button>
        <button
          type="button"
          disabled={!session}
          onClick={run('Cleared', async () => {
            await sendToWorker({ type: 'capture:clear' });
            await refresh();
          })}
        >
          Clear
        </button>
      </div>
      {note && <p style={{ fontSize: 11, color: '#555' }}>{note}</p>}
      <RequestList exchanges={filtered} />
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
