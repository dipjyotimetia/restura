/**
 * Push a capture session to the running Restura desktop app over the loopback
 * bridge. The `{ port, token }` pairing is stored in `chrome.storage.local` by
 * the options page; we POST to `http://127.0.0.1:<port>/ingest` with the bearer
 * token. The token never leaves the extension except over loopback.
 */
import type { CaptureSession } from '@shared/capture/types';

interface Pairing {
  port: number;
  token: string;
}

const KEY = 'restura:bridge:pairing';

export async function getPairing(): Promise<Pairing | null> {
  const out = await chrome.storage.local.get(KEY);
  return (out[KEY] as Pairing | undefined) ?? null;
}

export async function setPairing(pairing: Pairing): Promise<void> {
  await chrome.storage.local.set({ [KEY]: pairing });
}

export async function sendToDesktop(session: CaptureSession): Promise<void> {
  const pairing = await getPairing();
  if (!pairing)
    throw new Error('Not paired with Restura desktop. Set the pairing code in options.');
  const res = await fetch(`http://127.0.0.1:${pairing.port}/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${pairing.token}`,
    },
    body: JSON.stringify({ session, name: 'Captured Session' }),
  });
  if (!res.ok) throw new Error(`Desktop bridge rejected the session (${res.status}).`);
}
