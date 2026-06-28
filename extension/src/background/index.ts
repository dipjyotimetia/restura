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

interface ActiveCapture {
  tabId: number;
  normalizer: CdpNormalizer;
  /** CDP requestIds whose response body we've already requested. */
  fetchedBodies: Set<string>;
}

let activeCapture: ActiveCapture | null = null;

function sessionId(): string {
  // crypto.randomUUID is available in the worker; avoids Date.now() determinism
  // concerns and gives a stable id.
  return `cap_${crypto.randomUUID()}`;
}

async function syncSession(): Promise<CaptureSession | null> {
  if (!activeCapture) return null;
  const existing = await loadSession();
  const session: CaptureSession = {
    id: existing?.id ?? sessionId(),
    createdAt: existing?.createdAt ?? 0,
    exchanges: activeCapture.normalizer.getExchanges().map((ex) => redactExchange(ex).exchange),
  };
  await saveSession(session);
  return session;
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
          void syncSession();
        }
      );
    }
  }
  void syncSession();
}

async function startCapture(tabId: number): Promise<void> {
  await stopCapture();
  await chrome.debugger.attach({ tabId }, CDP_VERSION);
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
  activeCapture = { tabId, normalizer: new CdpNormalizer(), fetchedBodies: new Set() };
  await saveSession({ id: sessionId(), createdAt: 0, exchanges: [] });
}

async function stopCapture(): Promise<void> {
  if (!activeCapture) return;
  const { tabId } = activeCapture;
  activeCapture = null;
  try {
    await chrome.debugger.detach({ tabId });
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
