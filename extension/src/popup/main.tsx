import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { sendToWorker } from '../lib/runtime';

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
    <div style={{ padding: 12, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 14, margin: '0 0 8px' }}>Restura Capture</h1>
      <p style={{ fontSize: 12, color: '#555', margin: '0 0 12px' }}>
        {capturing ? `Capturing — ${count} request(s)` : 'Idle'}
      </p>
      <button type="button" onClick={() => void toggle()} disabled={busy} style={{ width: '100%' }}>
        {capturing ? 'Stop capture' : 'Start capture on this tab'}
      </button>
      <button
        type="button"
        onClick={() => void openPanel()}
        style={{ width: '100%', marginTop: 8 }}
      >
        Open capture panel
      </button>
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
