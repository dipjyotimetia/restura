/**
 * Persist the active capture session so it survives the MV3 service-worker
 * lifecycle (Chrome terminates idle workers aggressively). Uses
 * `chrome.storage.session` — in-memory, cleared when the browser closes, and not
 * written to disk, which is the right durability/secrecy tradeoff for
 * (already-redacted) captured traffic.
 */
import type { CaptureSession } from '@shared/capture/types';

const KEY = 'restura:capture:session';

export async function saveSession(session: CaptureSession | null): Promise<void> {
  await chrome.storage.session.set({ [KEY]: session });
}

export async function loadSession(): Promise<CaptureSession | null> {
  const out = await chrome.storage.session.get(KEY);
  return (out[KEY] as CaptureSession | null) ?? null;
}
