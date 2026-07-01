import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { sendToWorker } from '../lib/runtime';
import { Logo } from '../lib/Logo';
import '../styles.css';

function Popup(): React.JSX.Element {
  const [capturing, setCapturing] = useState(false);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    const state = await sendToWorker({ type: 'capture:get' });
    setCapturing(state?.capturing ?? false);
    setCount(state?.session?.exchanges.length ?? 0);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const toggle = async (): Promise<void> => {
    setBusy(true);
    try {
      if (capturing) {
        await sendToWorker({ type: 'capture:stop' });
      } else {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id != null) await sendToWorker({ type: 'capture:start', tabId: tab.id });
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const openPanel = async (): Promise<void> => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId });
  };

  return (
    <div className="rc-popup">
      <div className="rc-header">
        <Logo />
        <h1 className="rc-header__title">Restura Capture</h1>
      </div>

      <div className="rc-popup__status">
        <span className={capturing ? 'rc-popup__dot rc-popup__dot--live' : 'rc-popup__dot'} />
        {capturing ? (
          <span>
            Capturing — <span className="rc-popup__count">{count}</span> request
            {count === 1 ? '' : 's'}
          </span>
        ) : (
          <span>Idle</span>
        )}
      </div>

      <div className="rc-popup__actions">
        <button
          type="button"
          className={
            capturing
              ? 'rc-btn rc-btn--danger rc-btn--block'
              : 'rc-btn rc-btn--primary rc-btn--block'
          }
          onClick={() => void toggle()}
          disabled={busy}
        >
          {capturing ? 'Stop capture' : 'Start capture on this tab'}
        </button>
        <button
          type="button"
          className="rc-btn rc-btn--ghost rc-btn--block"
          onClick={() => void openPanel()}
        >
          Open capture panel
        </button>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Popup />
    </StrictMode>
  );
}
