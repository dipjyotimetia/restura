/**
 * Opt-in renderer telemetry. Sends `{ requestId, message, stack, build, ua }`
 * to the Worker at `/api/telemetry/error`. Gated on
 * `useSettingsStore.getState().settings.telemetry?.errorsEnabled` — default
 * false; no request fires until the user explicitly enables it.
 *
 * Never sends headers, response bodies, request payloads, or any field
 * outside the allowlist below.
 */

import { useSettingsStore } from '@/store/useSettingsStore';
import { workerBaseUrl, workerAuthHeaders } from '@/lib/shared/platform';

interface ErrorPayload {
  message: string;
  stack?: string;
  source: 'error-boundary' | 'window-error' | 'unhandled-rejection';
  componentStack?: string;
}

function isTelemetryEnabled(): boolean {
  try {
    return useSettingsStore.getState().settings.telemetry?.errorsEnabled === true;
  } catch {
    return false;
  }
}

export function reportError(payload: ErrorPayload): void {
  if (!isTelemetryEnabled()) return;
  const base = workerBaseUrl();
  // No worker configured (Electron without VITE_WORKER_URL or dev without a
  // running Miniflare). Drop silently — telemetry is a quality-of-life feature,
  // not a correctness one.
  if (!base && typeof window !== 'undefined' && window.location.protocol === 'file:') return;
  const url = `${base}/api/telemetry/error`;
  const body = {
    message: payload.message.slice(0, 2000),
    stack: payload.stack?.slice(0, 8000),
    componentStack: payload.componentStack?.slice(0, 4000),
    source: payload.source,
    build: import.meta.env.MODE,
    ua: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 256) : 'unknown',
    ts: Date.now(),
  };
  // sendBeacon survives page unload; preferred for unhandledrejection.
  try {
    if (typeof navigator !== 'undefined' && navigator.sendBeacon && payload.source !== 'error-boundary') {
      const blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
      navigator.sendBeacon(url, blob);
      return;
    }
  } catch { /* fall through to fetch */ }
  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...workerAuthHeaders() },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => { /* swallow — telemetry must never throw at the call site */ });
}

let installed = false;
export function installGlobalErrorHandlers(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (event) => {
    const err = event.error instanceof Error ? event.error : new Error(event.message);
    const payload: ErrorPayload = { message: err.message, source: 'window-error' };
    if (err.stack !== undefined) payload.stack = err.stack;
    reportError(payload);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    const payload: ErrorPayload = { message, source: 'unhandled-rejection' };
    if (reason instanceof Error && reason.stack !== undefined) payload.stack = reason.stack;
    reportError(payload);
  });
}
