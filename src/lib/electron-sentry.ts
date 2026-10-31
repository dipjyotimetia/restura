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
 * (electron/main/lifecycle/sentry.ts).
 *
 * Crash/error reporting only — no performance tracing. We init without a tracing
 * integration so the renderer emits no spans (a request span would leak the
 * arbitrary user URLs Restura proxies). The main-process SDK omits tracing too.
 *
 * This module also owns the renderer→main consent push: the canonical opt-in
 * flag lives in the Zustand settings store (persisted to Dexie), and main can't
 * read it, so we mirror it to main over IPC on startup and whenever it changes.
 */

import { createLogger } from '@/lib/shared/logger';
import { isElectron } from '@/lib/shared/platform';
import { useSettingsStore } from '@/store/useSettingsStore';

const log = createLogger('electron-sentry');

let consentSubscribed = false;

function readConsent(): boolean {
  return useSettingsStore.getState().settings.telemetry?.errorsEnabled === true;
}

function pushConsent(enabled: boolean): void {
  // Best-effort; telemetry must never break the app.
  void window.electron?.telemetry?.setConsent(enabled);
}

/**
 * Mirror the opt-in flag to main: once the store has rehydrated, then on every
 * change. The store rehydrates from Dexie asynchronously and starts on the default
 * (true), and a `true` push makes main init Sentry and create an install ID, so an
 * opted-out user must never see one. An opt-out is always safe, so it goes through
 * even if hydration never finishes (it can fail, leaving hasHydrated() false).
 */
function subscribeConsent(): void {
  if (consentSubscribed) return;
  consentSubscribed = true;
  const { persist } = useSettingsStore;
  let last: boolean | undefined;
  const push = (next: boolean): void => {
    if (next === last) return;
    last = next;
    pushConsent(next);
  };
  useSettingsStore.subscribe((state) => {
    const next = state.settings.telemetry?.errorsEnabled === true;
    if (!next || persist.hasHydrated()) push(next);
  });
  if (persist.hasHydrated()) push(readConsent());
  else persist.onFinishHydration(() => push(readConsent()));
}

export async function initElectronSentry(): Promise<void> {
  if (!isElectron()) return;
  // Keep consent flowing even if the SDK import fails.
  subscribeConsent();
  try {
    const Sentry = await import('@sentry/electron/renderer');
    // No DSN: the renderer SDK auto-connects to the main-process SDK over IPC.
    // No tracing integration — errors/crashes only, no spans.
    Sentry.init({
      // SDK 11 replaced `sendDefaultPii`; its defaults collect user info, so opt out
      // here too (events are also scrubbed in the main process before sending).
      dataCollection: { userInfo: false },
      // Filter noise from browser-extension scripts injected into the renderer —
      // this must be in the renderer SDK where extension URLs actually originate.
      denyUrls: [/extensions\//i, /^chrome-extension:\/\//, /^moz-extension:\/\//],
    });
  } catch (error) {
    // Best-effort: never block startup on telemetry.
    log.warn('failed to initialize renderer Sentry SDK', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
