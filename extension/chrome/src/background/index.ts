/**
 * Capture service worker. Owns the `chrome.debugger` attachment for the
 * user-selected tab, feeds CDP Network events through the shared `CdpNormalizer`,
 * redacts secrets as exchanges complete, and keeps the session in
 * `chrome.storage.session` so a worker restart mid-capture doesn't lose data:
 * the redacted session plus a small `CaptureMeta` are persisted, and `rehydrate`
 * re-seeds the normalizer and re-attaches the debugger on worker startup.
 *
 * Only ONE tab is captured at a time (the debugger banner makes multi-tab
 * capture hostile UX, and a single attachment keeps the privileged surface
 * minimal). Detaches on stop, on tab close, and on external detach.
 */
import { CdpNormalizer } from '@shared/capture/cdp-normalizer';
import { redactExchange } from '@shared/capture/secret-extractor';
import type { CaptureSession } from '@shared/capture/types';
import { type CaptureState, requestSchema } from '../lib/messages';
import { clearMeta, loadMeta, loadSession, saveMeta, saveSession } from './session-store';

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

async function publishCaptureState(session?: CaptureSession | null): Promise<void> {
  const currentSession = session === undefined ? await loadSession() : session;
  await chrome.runtime
    .sendMessage({
      type: 'capture:state',
      state: {
        capturing: activeCapture !== null,
        tabId: activeCapture?.tabId ?? null,
        session: currentSession,
      },
    })
    .catch(() => undefined);
}

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
    if (activeCapture === capture) {
      const session = buildSession(capture);
      void saveSession(session).then(() => publishCaptureState(session));
    }
  }, SYNC_DEBOUNCE_MS);
}

/**
 * End a capture: flush the trailing debounce window and drop the resume meta so
 * a later worker restart doesn't try to re-attach. Shared by stop and external
 * detach so neither path silently loses the last batch.
 */
async function finalizeCapture(capture: ActiveCapture): Promise<void> {
  if (capture.flushTimer) clearTimeout(capture.flushTimer);
  const session = buildSession(capture);
  await saveSession(session);
  await clearMeta();
  await publishCaptureState(session);
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
  const createdAt = Date.now();
  const sessionId = newSessionId();
  activeCapture = {
    tabId,
    sessionId,
    createdAt,
    normalizer: new CdpNormalizer(),
    fetchedBodies: new Set(),
    flushTimer: null,
  };
  await saveMeta({ tabId, sessionId, createdAt });
  const session = buildSession(activeCapture);
  await saveSession(session);
  await publishCaptureState(session);
}

async function stopCapture(): Promise<void> {
  if (!activeCapture) return;
  const capture = activeCapture;
  activeCapture = null;
  await finalizeCapture(capture);
  try {
    await chrome.debugger.detach({ tabId: capture.tabId });
  } catch {
    /* already detached (tab closed) */
  }
}

/**
 * Resume a capture after an MV3 worker restart. The redacted session and a
 * `CaptureMeta` survive in `chrome.storage.session`; re-seed the normalizer from
 * the stored exchanges (redaction is idempotent) and re-attach the debugger. If
 * the tab is gone, the stale state is cleared.
 */
async function rehydrate(): Promise<void> {
  if (activeCapture) return;
  const meta = await loadMeta();
  if (!meta) return;
  try {
    await chrome.debugger.attach({ tabId: meta.tabId }, CDP_VERSION);
    await chrome.debugger.sendCommand({ tabId: meta.tabId }, 'Network.enable');
  } catch {
    // Tab closed or already being debugged — drop the unrecoverable session.
    await clearMeta();
    return;
  }
  const normalizer = new CdpNormalizer();
  const prior = await loadSession();
  if (prior) normalizer.seed(prior.exchanges);
  activeCapture = {
    tabId: meta.tabId,
    sessionId: meta.sessionId,
    createdAt: meta.createdAt,
    normalizer,
    fetchedBodies: new Set(),
    flushTimer: null,
  };
}

chrome.debugger.onEvent.addListener(onDebuggerEvent);
// External detach (DevTools opened on the tab, tab navigated/closed). The worker
// is alive here, so finalize: flush the trailing window and clear resume meta so
// a later restart doesn't fight the detach. (Pure SW termination fires no event,
// leaving meta intact for `rehydrate`.)
chrome.debugger.onDetach.addListener((source) => {
  const capture = activeCapture;
  if (capture && source.tabId === capture.tabId) {
    activeCapture = null;
    void finalizeCapture(capture);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeCapture?.tabId === tabId) void stopCapture();
});

// Re-attach an in-flight capture after the MV3 worker was recycled.
void rehydrate();

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
        await clearMeta();
        await publishCaptureState(null);
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
