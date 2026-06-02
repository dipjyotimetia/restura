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
 * Crash/error reporting only — no performance tracing. We init without a tracing
 * integration so the renderer emits no spans (a request span would leak the
 * arbitrary user URLs Restura proxies). The main-process SDK omits tracing too.
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
    // No tracing integration — errors/crashes only, no spans.
    Sentry.init({});
  } catch {
    // Best-effort: never block startup on telemetry.
  }
}
