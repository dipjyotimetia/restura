import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getPairing, parsePairingCode, setPairing } from '../lib/bridge-client';

/**
 * Pairing page. The desktop app surfaces a one-line code `<port>:<token>` when
 * the bridge starts; the user pastes it here. We never auto-read the desktop
 * handshake file — the extension sandbox can't reach it, and an explicit paste
 * keeps the pairing user-initiated.
 */
function Options(): React.JSX.Element {
  const [code, setCode] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    void getPairing().then((p) => {
      if (p) setStatus(`Paired with 127.0.0.1:${p.port}`);
    });
  }, []);

  const save = async (): Promise<void> => {
    const pairing = parsePairingCode(code);
    if (!pairing) {
      setStatus('Invalid code. Expected "<port>:<token>".');
      return;
    }
    await setPairing(pairing);
    setStatus(`Paired with 127.0.0.1:${pairing.port}`);
    setCode('');
  };

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 480 }}>
      <h1 style={{ fontSize: 16 }}>Restura Capture — Desktop pairing</h1>
      <p style={{ fontSize: 13, color: '#555' }}>
        In Restura desktop, start the capture bridge and paste the pairing code below.
      </p>
      <input
        placeholder="3000:abcdef…"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        style={{ width: '100%', padding: 8, marginBottom: 8 }}
      />
      <button type="button" onClick={() => void save()}>
        Save pairing
      </button>
      {status && <p style={{ fontSize: 12, marginTop: 12 }}>{status}</p>}
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Options />
    </StrictMode>
  );
}
