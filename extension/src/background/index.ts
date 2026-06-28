/**
 * Capture service worker. Owns the `chrome.debugger` attachment for the
 * user-selected tab, feeds CDP Network events through the shared `CdpNormalizer`,
 * redacts secrets as exchanges complete, and keeps the session in
 * `chrome.storage.session` so a worker restart mid-capture doesn't lose data.
 *
 * Only ONE tab is captured at a time (the debugger banner makes multi-tab
 * capture hostile UX, and a single attachment keeps the privileged surface
 * minimal). Detaches on stop, on tab close, and on worker suspend.
 */
import { CdpNormalizer } from '@shared/capture/cdp-normalizer';
import { redactExchange } from '@shared/capture/secret-extractor';
import type { CaptureSession } from '@shared/capture/types';
import { type CaptureState, requestSchema } from '../lib/messages';
import { loadSession, saveSession } from './session-store';

const CDP_VERSION = '1.3';

/** Coalesce a burst of CDP events into one redact-and-persist pass. */
const SYNC_DEBOUNCE_MS = 150;

interface ActiveCapture {
  tabId: number;
  sessionId: string;
  createdAt: number;
  normalizer: CdpNormalizer;
  /** CDP requestIds whose response body we've already requested. */
  fetchedBodies: Set<string>;
  /** Pending coalesced flush, if any. */
  flushTimer: ReturnType<typeof setTimeout> | null;
}

let activeCapture: ActiveCapture | null = null;

function newSessionId(): string {
  // crypto.randomUUID avoids Date.now() determinism concerns and gives a stable id.
  return `cap_${crypto.randomUUID()}`;
}

function buildSession(capture: ActiveCapture): CaptureSession {
  return {
    id: capture.sessionId,
    createdAt: capture.createdAt,
    exchanges: capture.normalizer.getExchanges().map((ex) => redactExchange(ex).exchange),
  };
}

/**
 * Persist the session, coalescing rapid CDP events so a busy page produces one
 * redact-and-write per window instead of one per event. No `loadSession` read —
 * the session id/createdAt are cached on the capture, and the normalizer is the
 * source of truth for exchanges.
 */
function scheduleSync(): void {
  const capture = activeCapture;
  if (!capture || capture.flushTimer) return;
  capture.flushTimer = setTimeout(() => {
    capture.flushTimer = null;
    if (activeCapture === capture) void saveSession(buildSession(capture));
  }, SYNC_DEBOUNCE_MS);
}

function onDebuggerEvent(source: chrome.debugger.Debuggee, method: string, params?: object): void {
  if (!activeCapture || source.tabId !== activeCapture.tabId) return;
  activeCapture.normalizer.ingest(method, params);

  // Lazily pull response bodies once the response has fully loaded.
  if (method === 'Network.loadingFinished' && params) {
    const requestId = (params as { requestId?: string }).requestId;
    if (requestId && !activeCapture.fetchedBodies.has(requestId)) {
      activeCapture.fetchedBodies.add(requestId);
      chrome.debugger.sendCommand(
        { tabId: activeCapture.tabId },
        'Network.getResponseBody',
        { requestId },
        (result?: object) => {
          if (chrome.runtime.lastError || !result || !activeCapture) return;
          const body = result as { body: string; base64Encoded: boolean };
          activeCapture.normalizer.attachResponseBody(
            requestId,
            body.base64Encoded ? { base64: body.body } : { text: body.body }
          );
          scheduleSync();
        }
      );
    }
  }
  scheduleSync();
}

async function startCapture(tabId: number): Promise<void> {
  await stopCapture();
  await chrome.debugger.attach({ tabId }, CDP_VERSION);
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
  activeCapture = {
    tabId,
    sessionId: newSessionId(),
    createdAt: 0,
    normalizer: new CdpNormalizer(),
    fetchedBodies: new Set(),
    flushTimer: null,
  };
  await saveSession(buildSession(activeCapture));
}

async function stopCapture(): Promise<void> {
  if (!activeCapture) return;
  const capture = activeCapture;
  activeCapture = null;
  if (capture.flushTimer) clearTimeout(capture.flushTimer);
  // Final flush so the last events aren't lost to the debounce window.
  await saveSession(buildSession(capture));
  try {
    await chrome.debugger.detach({ tabId: capture.tabId });
  } catch {
    /* already detached (tab closed) */
  }
}

chrome.debugger.onEvent.addListener(onDebuggerEvent);
chrome.debugger.onDetach.addListener((source) => {
  if (activeCapture && source.tabId === activeCapture.tabId) activeCapture = null;
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeCapture?.tabId === tabId) void stopCapture();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const parsed = requestSchema.safeParse(message);
  if (!parsed.success) {
    sendResponse({ ok: false, error: 'invalid message' });
    return false;
  }
  void (async () => {
    switch (parsed.data.type) {
      case 'capture:start':
        await startCapture(parsed.data.tabId);
        break;
      case 'capture:stop':
        await stopCapture();
        break;
      case 'capture:clear':
        await saveSession(null);
        break;
      case 'capture:get':
        break;
    }
    const state: CaptureState = {
      capturing: activeCapture !== null,
      tabId: activeCapture?.tabId ?? null,
      session: await loadSession(),
    };
    sendResponse({ ok: true, state });
  })();
  return true; // async response
});
