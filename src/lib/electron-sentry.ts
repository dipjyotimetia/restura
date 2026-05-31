/**
 * Renderer-side Sentry bootstrap — Electron target ONLY.
 *
 * The web and Node/Docker bundles never initialise Sentry: the `isElectron()`
 * guard short-circuits, and `@sentry/electron/renderer` is loaded via a dynamic
 * `import()` so Vite splits it out of the eager web bundle entirely.
 *
 * The renderer SDK carries NO DSN — it forwards captured events to the
 * main-process SDK over IPC (via the `@sentry/electron/preload` shim), so the
 * sandboxed renderer never makes a direct network call. Scrubbing, the opt-in
 * gate, release/environment, and the actual upload all live in the main process
 * (electron/main/sentry.ts).
 *
 * Performance tracing keeps URL-free signals (pageload / navigation / web
 * vitals) but disables fetch/XHR request spans (`traceFetch`/`traceXHR: false`)
 * — Restura issues requests to arbitrary user URLs, and a request span would
 * leak the target endpoint. The main-process SDK suppresses outbound-HTTP spans
 * the same way.
 *
 * This module also owns the renderer→main consent push: the canonical opt-in
 * flag lives in the Zustand settings store (persisted to Dexie), and main can't
 * read it, so we mirror it to main over IPC on startup and whenever it changes.
 */

import { isElectron } from '@/lib/shared/platform';
import { useSettingsStore } from '@/store/useSettingsStore';

let consentSubscribed = false;

function readConsent(): boolean {
  return useSettingsStore.getState().settings.telemetry?.errorsEnabled === true;
}

function pushConsent(enabled: boolean): void {
  // Best-effort; telemetry must never break the app.
  void window.electron?.telemetry?.setConsent(enabled);
}

/**
 * Push the current opt-in flag to main, then forward every change. The store
 * rehydrates from Dexie asynchronously, so the initial push may carry the
 * default (true); the subscription then catches the rehydrated value if it differs.
 */
function subscribeConsent(): void {
  if (consentSubscribed) return;
  consentSubscribed = true;
  let last = readConsent();
  pushConsent(last);
  useSettingsStore.subscribe((state) => {
    const next = state.settings.telemetry?.errorsEnabled === true;
    if (next !== last) {
      last = next;
      pushConsent(next);
    }
  });
}

export async function initElectronSentry(): Promise<void> {
  if (!isElectron()) return;
  // Keep consent flowing even if the SDK import fails.
  subscribeConsent();
  try {
    const Sentry = await import('@sentry/electron/renderer');
    // No DSN: the renderer SDK auto-connects to the main-process SDK over IPC.
    // Disable fetch/XHR request spans so no target URL is captured renderer-side.
    Sentry.init({
      integrations: [Sentry.browserTracingIntegration({ traceFetch: false, traceXHR: false })],
    });
  } catch {
    // Best-effort: never block startup on telemetry.
  }
}
