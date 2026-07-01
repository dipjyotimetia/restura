import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getPairing, parsePairingCode, setPairing } from '../lib/bridge-client';
import { Logo } from '../lib/Logo';
import '../styles.css';

/**
 * Pairing page. The desktop app surfaces a one-line code `<port>:<token>` when
 * the bridge starts; the user pastes it here. We never auto-read the desktop
 * handshake file — the extension sandbox can't reach it, and an explicit paste
 * keeps the pairing user-initiated.
 */
type StatusKind = 'none' | 'ok' | 'error';

function Options(): React.JSX.Element {
  const [code, setCode] = useState('');
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState<StatusKind>('none');

  useEffect(() => {
    void getPairing().then((p) => {
      if (p) {
        setStatus(`Paired with 127.0.0.1:${p.port}`);
        setKind('ok');
      }
    });
  }, []);

  const save = async (): Promise<void> => {
    const pairing = parsePairingCode(code);
    if (!pairing) {
      setStatus('Invalid code. Expected "<port>:<token>".');
      setKind('error');
      return;
    }
    await setPairing(pairing);
    setStatus(`Paired with 127.0.0.1:${pairing.port}`);
    setKind('ok');
    setCode('');
  };

  const chipClass =
    kind === 'ok' ? 'rc-chip rc-chip--ok' : kind === 'error' ? 'rc-chip rc-chip--error' : 'rc-chip';

  return (
    <div className="rc-page">
      <div className="rc-card">
        <div className="rc-header">
          <Logo size={20} />
          <h1 className="rc-header__title">Restura Capture — Desktop pairing</h1>
        </div>
        <p className="rc-card__desc">
          In Restura desktop, start the capture bridge and paste the pairing code below.
        </p>
        <div className="rc-field">
          <input
            className="rc-input"
            placeholder="3000:abcdef…"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button type="button" className="rc-btn rc-btn--primary" onClick={() => void save()}>
            Save pairing
          </button>
        </div>
        {status && (
          <div className={chipClass}>
            <span className="rc-chip__dot" />
            {status}
          </div>
        )}
      </div>
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
