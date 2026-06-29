/**
 * Thin typed wrapper over `chrome.runtime.sendMessage` to the service worker.
 */
import { type CaptureRequest, type CaptureState, captureStateSchema } from './messages';

interface WorkerResponse {
  ok: boolean;
  error?: string;
  state?: unknown;
}

export async function sendToWorker(request: CaptureRequest): Promise<CaptureState | null> {
  const res = (await chrome.runtime.sendMessage(request)) as WorkerResponse | undefined;
  if (!res?.ok) return null;
  const parsed = captureStateSchema.safeParse(res.state);
  return parsed.success ? parsed.data : null;
}
