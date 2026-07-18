/**
 * Persist the active capture session so it survives the MV3 service-worker
 * lifecycle (Chrome terminates idle workers aggressively). Uses
 * `chrome.storage.session` — in-memory, cleared when the browser closes, and not
 * written to disk, which is the right durability/secrecy tradeoff for
 * (already-redacted) captured traffic.
 */
import type { CaptureSession } from '@shared/capture/types';

export const CAPTURE_SESSION_KEY = 'restura:capture:session';
const META_KEY = 'restura:capture:meta';

/**
 * The small descriptor needed to resume a capture after an MV3 worker restart:
 * which tab was attached and the session identity. Present only while capturing.
 */
export interface CaptureMeta {
  tabId: number;
  sessionId: string;
  createdAt: number;
}

export async function saveSession(session: CaptureSession | null): Promise<void> {
  await chrome.storage.session.set({ [CAPTURE_SESSION_KEY]: session });
}

export async function loadSession(): Promise<CaptureSession | null> {
  const out = await chrome.storage.session.get(CAPTURE_SESSION_KEY);
  return (out[CAPTURE_SESSION_KEY] as CaptureSession | null) ?? null;
}

export async function saveMeta(meta: CaptureMeta): Promise<void> {
  await chrome.storage.session.set({ [META_KEY]: meta });
}

export async function loadMeta(): Promise<CaptureMeta | null> {
  const out = await chrome.storage.session.get(META_KEY);
  return (out[META_KEY] as CaptureMeta | null) ?? null;
}

export async function clearMeta(): Promise<void> {
  await chrome.storage.session.remove(META_KEY);
}
