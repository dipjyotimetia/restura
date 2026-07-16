import { capturedProtocolSchema } from '@shared/capture/schema';
import type { CapturedProtocol } from '@shared/capture/types';
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { sendToDesktop } from '../lib/bridge-client';
import { exportHar, exportOpenCollection } from '../lib/export-actions';
import { Logo } from '../lib/Logo';
import type { CaptureState } from '../lib/messages';
import { sendToWorker, subscribeToCaptureState } from '../lib/runtime';
import { RequestList } from './RequestList';
import '../styles.css';

// Derived from the schema so a new protocol can't silently miss the filter.
const PROTOCOLS: (CapturedProtocol | 'all')[] = ['all', ...capturedProtocolSchema.options];

function App(): React.JSX.Element {
  const [state, setState] = useState<CaptureState | null>(null);
  const [filter, setFilter] = useState('');
  const [protocol, setProtocol] = useState<CapturedProtocol | 'all'>('all');
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState(false);

  useEffect(() => {
    void sendToWorker({ type: 'capture:get' }).then(setState);
    return subscribeToCaptureState(setState);
  }, []);

  const exchanges = state?.session?.exchanges ?? [];
  const filtered = useMemo(() => {
    const needle = filter.toLowerCase();
    return exchanges.filter(
      (ex) =>
        (protocol === 'all' || ex.protocol === protocol) &&
        (needle === '' || ex.url.toLowerCase().includes(needle))
    );
  }, [exchanges, filter, protocol]);

  const session = state?.session ?? null;
  const run = (label: string, fn: () => void | Promise<void>) => async () => {
    try {
      await fn();
      setNote(`${label} ✓`);
      setNoteError(false);
    } catch (err) {
      setNote(err instanceof Error ? err.message : `${label} failed`);
      setNoteError(true);
    }
  };

  return (
    <div className="rc-panel-body">
      <div className="rc-header">
        <Logo />
        <h1 className="rc-header__title">Restura Capture</h1>
        <span className="rc-header__spacer" />
        {state?.capturing && (
          <span className="rc-rec">
            <span className="rc-rec__dot" />
            REC
          </span>
        )}
      </div>
      <div className="rc-divider" />

      <div className="rc-controls">
        <span className="rc-search">
          <span className="rc-search__icon">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </span>
          <input
            className="rc-input"
            placeholder="Filter URL…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </span>
        <select
          className="rc-select"
          value={protocol}
          onChange={(e) => setProtocol(e.target.value as CapturedProtocol)}
        >
          {PROTOCOLS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      <div className="rc-toolbar">
        <button
          type="button"
          className="rc-btn rc-btn--primary"
          disabled={!session}
          onClick={run('Sent to desktop', async () => {
            if (session) await sendToDesktop(session);
          })}
        >
          Send to Desktop
        </button>
        <button
          type="button"
          className="rc-btn rc-btn--ghost"
          disabled={!session}
          onClick={run('OpenCollection exported', () => {
            if (session) exportOpenCollection(session);
          })}
        >
          Export OpenCollection
        </button>
        <button
          type="button"
          className="rc-btn rc-btn--ghost"
          disabled={!session}
          onClick={run('HAR exported', () => {
            if (session) exportHar(session);
          })}
        >
          Export HAR
        </button>
        <button
          type="button"
          className="rc-btn rc-btn--danger"
          disabled={!session}
          onClick={run('Cleared', async () => {
            await sendToWorker({ type: 'capture:clear' });
            setState(await sendToWorker({ type: 'capture:get' }));
          })}
        >
          Clear
        </button>
      </div>

      {note && <p className={noteError ? 'rc-note rc-note--error' : 'rc-note'}>{note}</p>}
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
