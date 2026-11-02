import { PROXY_STREAM_MARKER_HEADER } from '@shared/protocol/proxy-limits';
import type { ProxyRequestBody } from '@shared/protocol/proxy-schema';
import { isReconnectableSseResponse } from '@shared/protocol/sse-parser';
import { useSseStore } from '@/features/sse/store/useSseStore';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import {
  connectionChannels,
  createSseDesktopAdapter,
} from '@/lib/shared/streaming/desktopStreamAdapter';
import { openStreamSession } from '@/lib/shared/streaming/streamSession';
import { executeProxiedStreamingRequest } from '@/lib/shared/transport';
import { EVENT_PREFIX } from '../../../../electron/shared/channels';
import type { SseClosePayload } from '../../../../electron/types/api/protocols';
import { type ParsedSseEvent, SseParser } from './sseParser';

/**
 * Wire spec for opening an SSE stream through the streaming proxy. Shared by
 * this manager and the store-free `sseStartStream` (`src/features/sse/protocol.ts`)
 * so the streaming shape is defined once. The orchestrator-side timeout is
 * disabled: the caller controls the stream's lifetime with its AbortController.
 */
export function buildSseStreamSpec(
  url: string,
  headers: Record<string, string>,
  stripOnOriginChange: readonly string[] = []
): ProxyRequestBody {
  return {
    method: 'GET',
    url,
    headers,
    streamingMode: true,
    timeout: 0,
    ...(stripOnOriginChange.length > 0
      ? { redirectPolicy: { stripOnOriginChange: [...stripOnOriginChange] } }
      : {}),
  };
}

/**
 * Remove all `sse:{open,event,error,close}:<connectionId>` IPC listeners, by
 * connection id rather than by session: a retry or `disconnect()` has to clear
 * whatever an earlier attempt left on the same id.
 */
export function cleanupSseElectronListeners(
  connectionId: string,
  api: ReturnType<typeof getElectronAPI>
): void {
  for (const channel of Object.values(connectionChannels(EVENT_PREFIX.sse, connectionId))) {
    api?.sse?.removeAllListeners(channel);
  }
}

/**
 * A 502/503/504 the Worker generated itself (upstream unreachable / timed
 * out — no stream marker) is a network error, which WHATWG §9.2.3 retries,
 * matching Electron where the same failure closes non-fatally. An upstream's
 * own non-2xx carries the marker and still fails the connection.
 */
function isProxyTransportFailure(response: Response): boolean {
  return (
    response.headers.get(PROXY_STREAM_MARKER_HEADER) === null &&
    (response.status === 502 || response.status === 503 || response.status === 504)
  );
}

/** How one connect attempt ended — `fatal` per WHATWG "fail the connection". */
interface AttemptEnd {
  message: string;
  fatal: boolean;
}

/** One attempt (initial connect or reconnect); stale callbacks compare against the session's. */
interface Attempt {
  ended: boolean;
}

/**
 * A user-initiated stream and its automatic reconnects (WHATWG §9.2.3), alive
 * from `connect()` until `disconnect()` or a final, non-retried end.
 */
interface SseSession {
  url: string;
  /** User headers, without `Last-Event-ID` (recomputed per attempt). */
  headers: Record<string, string>;
  reconnectOnResume: boolean;
  /** Auth-added header names, removed on a redirect to another origin. */
  stripOnOriginChange: string[];
  autoReconnect: boolean;
  /** Reconnection time in ms — the store default until the server sends `retry:`. */
  retryMs: number;
  /**
   * Reconnects scheduled since a stream last delivered an event (capped by
   * `maxReconnectAttempts`). Reset on the first event, not on open, so an
   * upstream that accepts and immediately closes can't loop forever.
   */
  failures: number;
  /** A stream opened in this session — arms auto-reconnect for connect-phase failures too. */
  opened: boolean;
  attempt: Attempt;
  timer?: ReturnType<typeof setTimeout>;
}

// Singleton SSE manager. Desktop → `sse:connect` IPC. Web → proxied
// stream via `/api/proxy`. Native EventSource and direct fetch are
// intentionally absent — they bypassed the Worker's SSRF / header / auth
// guards.
class SseManager {
  /** AbortControllers for proxied web connections — abort closes the fetch stream. */
  private webConnections = new Map<string, AbortController>();
  /** Electron-managed connections — no local socket; teardown via IPC. */
  private electronConnections = new Set<string>();
  private sessions = new Map<string, SseSession>();

  private static DEFAULT_CONNECTION_TIMEOUT = 30000;

  private validateUrl(url: string): { valid: boolean; error?: string } {
    if (!url?.trim()) return { valid: false, error: 'URL is required' };
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return {
          valid: false,
          error: `Invalid protocol "${parsed.protocol}". URL must start with http:// or https://`,
        };
      }
      return { valid: true };
    } catch {
      return { valid: false, error: 'Invalid URL format' };
    }
  }

  /**
   * `options` come from the tab's `SseRequest` (request config is not kept in
   * `useSseStore`); both default to true.
   */
  connect(
    connectionId: string,
    url: string,
    headers?: Record<string, string>,
    options: {
      reconnectOnResume?: boolean;
      autoReconnect?: boolean;
      stripOnOriginChange?: string[];
    } = {}
  ): void {
    this.disconnect(connectionId);

    const store = useSseStore.getState();
    const validation = this.validateUrl(url);
    if (!validation.valid) {
      store.appendSystem(connectionId, `Connection failed: ${validation.error}`);
      store.updateConnectionStatus(connectionId, 'disconnected');
      return;
    }

    store.updateConnectionStatus(connectionId, 'connecting');
    store.setReconnectAttempts(connectionId, 0);

    const session: SseSession = {
      url,
      headers: { ...(headers ?? {}) },
      reconnectOnResume: options.reconnectOnResume ?? true,
      stripOnOriginChange: options.stripOnOriginChange ?? [],
      autoReconnect: options.autoReconnect ?? true,
      retryMs: store.connections[connectionId]?.reconnectDelay ?? 1000,
      failures: 0,
      opened: false,
      attempt: { ended: false },
    };
    this.sessions.set(connectionId, session);
    this.openAttempt(connectionId, session);
  }

  disconnect(connectionId: string): void {
    const session = this.sessions.get(connectionId);
    if (session) {
      // Cancels a pending reconnect and orphans the in-flight attempt.
      clearTimeout(session.timer);
      session.attempt.ended = true;
      this.sessions.delete(connectionId);
    }

    if (this.electronConnections.has(connectionId)) {
      const api = getElectronAPI();
      api?.sse?.disconnect({ connectionId });
      this.electronConnections.delete(connectionId);
      cleanupSseElectronListeners(connectionId, api);
    }

    const ac = this.webConnections.get(connectionId);
    if (ac) {
      ac.abort();
      this.webConnections.delete(connectionId);
    }

    if (session) {
      const s = useSseStore.getState();
      s.updateConnectionStatus(connectionId, 'disconnected');
      s.setReconnectAttempts(connectionId, 0);
    }
  }

  isConnected(connectionId: string): boolean {
    if (this.electronConnections.has(connectionId)) {
      return useSseStore.getState().connections[connectionId]?.status === 'connected';
    }
    return this.webConnections.has(connectionId);
  }

  cleanup(): void {
    const ids = new Set([
      ...this.webConnections.keys(),
      ...this.electronConnections,
      ...this.sessions.keys(),
    ]);
    for (const id of ids) this.disconnect(id);
  }

  // ---------------------------------------------------------------- private

  private openAttempt(connectionId: string, session: SseSession): void {
    const attempt: Attempt = { ended: false };
    session.attempt = attempt;
    session.timer = undefined;

    // Resume from the last event ID; "" (an empty `id:` reset) sends none.
    const lastEventId = useSseStore.getState().connections[connectionId]?.lastEventId;
    const headers: Record<string, string> = { ...session.headers };
    if (session.reconnectOnResume && lastEventId) headers['Last-Event-ID'] = lastEventId;

    if (isElectron()) {
      this.connectViaElectron(
        connectionId,
        session.url,
        headers,
        attempt,
        session.stripOnOriginChange
      );
      return;
    }
    void this.connectViaProxy(
      connectionId,
      session.url,
      headers,
      attempt,
      session.stripOnOriginChange
    );
  }

  private isCurrent(connectionId: string, attempt: Attempt): boolean {
    return !attempt.ended && this.sessions.get(connectionId)?.attempt === attempt;
  }

  private onOpened(connectionId: string, attempt: Attempt, url: string): void {
    const session = this.sessions.get(connectionId);
    if (!session || !this.isCurrent(connectionId, attempt)) return;
    session.opened = true;
    const s = useSseStore.getState();
    s.updateConnectionStatus(connectionId, 'connected');
    s.setLastConnectedAt(connectionId, Date.now());
    s.appendSystem(connectionId, `Connected to ${url}`);
  }

  private onEvent(connectionId: string, attempt: Attempt, e: ParsedSseEvent): void {
    if (!this.isCurrent(connectionId, attempt)) return;
    const session = this.sessions.get(connectionId);
    if (session) {
      session.failures = 0;
      if (e.retry !== undefined) session.retryMs = e.retry;
    }
    useSseStore.getState().appendEvent(connectionId, {
      event: e.event,
      data: e.data,
      ...(e.lastEventId !== undefined ? { lastEventId: e.lastEventId } : {}),
      ...(e.retry !== undefined ? { retry: e.retry } : {}),
    });
  }

  /**
   * Fold stream state that data-less blocks may have moved (`id:` heartbeats,
   * empty-id resets, bare `retry:`) into the session/store.
   */
  private syncStreamState(
    connectionId: string,
    attempt: Attempt,
    lastEventId: string | undefined,
    retry: number | undefined
  ): void {
    if (!this.isCurrent(connectionId, attempt)) return;
    const session = this.sessions.get(connectionId);
    if (session && retry !== undefined) session.retryMs = retry;
    const s = useSseStore.getState();
    if (lastEventId !== undefined && s.connections[connectionId]?.lastEventId !== lastEventId) {
      s.setLastEventId(connectionId, lastEventId);
    }
  }

  /**
   * Single exit for an attempt: reconnect after the reconnection time unless
   * the end was fatal, the user turned auto-reconnect off, the stream never
   * opened in this session, or the consecutive-attempt cap is spent.
   */
  private endAttempt(connectionId: string, attempt: Attempt, end: AttemptEnd): void {
    const session = this.sessions.get(connectionId);
    if (!session || !this.isCurrent(connectionId, attempt)) return;
    attempt.ended = true;

    const s = useSseStore.getState();
    s.appendSystem(connectionId, end.message);
    const conn = s.connections[connectionId];
    const max = conn?.maxReconnectAttempts ?? 5;
    if (!end.fatal && session.autoReconnect && session.opened && session.failures < max) {
      session.failures += 1;
      s.updateConnectionStatus(connectionId, 'reconnecting');
      s.setReconnectAttempts(connectionId, (conn?.reconnectAttempts ?? 0) + 1);
      s.appendSystem(
        connectionId,
        `Reconnecting in ${session.retryMs} ms (attempt ${session.failures}/${max})`
      );
      session.timer = setTimeout(() => {
        if (this.sessions.get(connectionId) === session) this.openAttempt(connectionId, session);
      }, session.retryMs);
      return;
    }

    if (!end.fatal && session.autoReconnect && session.opened) {
      s.appendSystem(connectionId, `Gave up after ${max} reconnect attempts`);
    }
    this.sessions.delete(connectionId);
    s.updateConnectionStatus(connectionId, 'disconnected');
  }

  private async connectViaProxy(
    connectionId: string,
    url: string,
    headers: Record<string, string>,
    attempt: Attempt,
    stripOnOriginChange: string[]
  ): Promise<void> {
    const controller = new AbortController();
    this.webConnections.set(connectionId, controller);
    const release = () => {
      if (this.webConnections.get(connectionId) === controller) {
        this.webConnections.delete(connectionId);
      }
    };

    const timeoutId = setTimeout(() => {
      controller.abort();
    }, SseManager.DEFAULT_CONNECTION_TIMEOUT);

    try {
      // signal goes through to fetch so abort during the request/connect
      // phase actually closes the socket — not just the body afterward.
      const response = await executeProxiedStreamingRequest(
        buildSseStreamSpec(url, { Accept: 'text/event-stream', ...headers }, stripOnOriginChange),
        { signal: controller.signal }
      );
      clearTimeout(timeoutId);

      if (!response.ok) {
        response.body?.cancel().catch(() => {});
        release();
        this.endAttempt(connectionId, attempt, {
          message: `HTTP ${response.status} ${response.statusText}`,
          fatal: !isProxyTransportFailure(response),
        });
        return;
      }
      if (!response.body) {
        release();
        this.endAttempt(connectionId, attempt, { message: 'No response body', fatal: true });
        return;
      }

      // 204 / wrong Content-Type: still shown, but never auto-reconnected.
      const reconnectable = isReconnectableSseResponse(
        response.status,
        response.headers.get('content-type')
      );
      this.onOpened(connectionId, attempt, url);

      const decoder = new TextDecoder();
      const parser = new SseParser();
      const reader = response.body.getReader();
      const onEvent = (e: ParsedSseEvent) => this.onEvent(connectionId, attempt, e);
      const sync = () =>
        this.syncStreamState(
          connectionId,
          attempt,
          parser.getLastEventId(),
          parser.getReconnectionTime()
        );

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }), onEvent);
        sync();
      }
      parser.feed(decoder.decode(), onEvent);
      sync();

      release();
      this.endAttempt(connectionId, attempt, { message: 'Stream closed', fatal: !reconnectable });
    } catch (error) {
      clearTimeout(timeoutId);
      release();
      if (!this.isCurrent(connectionId, attempt)) {
        // User disconnect / superseding connect: they own the status.
        if (controller.signal.aborted) {
          useSseStore.getState().appendSystem(connectionId, 'Stream aborted');
        }
        return;
      }
      this.endAttempt(connectionId, attempt, {
        message: controller.signal.aborted
          ? 'Stream aborted: connection timed out'
          : `Stream error: ${error instanceof Error ? error.message : 'Unknown'}`,
        fatal: false,
      });
    }
  }

  private connectViaElectron(
    connectionId: string,
    url: string,
    headers: Record<string, string>,
    attempt: Attempt,
    stripOnOriginChange: string[]
  ): void {
    const api = getElectronAPI();
    if (!api?.sse) {
      this.endAttempt(connectionId, attempt, {
        message: 'Electron SSE API not available',
        fatal: true,
      });
      return;
    }

    // Always clear any prior listeners for this id before re-registering — otherwise
    // a retry after a failed connect leaves stale handlers that fire on the next event.
    cleanupSseElectronListeners(connectionId, api);
    // Tracked from the start so a disconnect while still connecting reaches main.
    this.electronConnections.add(connectionId);

    const finish = (end: AttemptEnd) => {
      if (!this.isCurrent(connectionId, attempt)) return;
      this.electronConnections.delete(connectionId);
      session.dispose();
      this.endAttempt(connectionId, attempt, end);
    };

    const session = openStreamSession(
      createSseDesktopAdapter(api.sse, {
        connectionId,
        url,
        headers,
        ...(stripOnOriginChange.length > 0 ? { stripOnOriginChange } : {}),
      }),
      {
        listeners: {
          open: () => {
            this.onOpened(connectionId, attempt, url);
          },
          event: (payload) => {
            this.onEvent(connectionId, attempt, payload as ParsedSseEvent);
          },
          error: (payload) => {
            if (!this.isCurrent(connectionId, attempt)) return;
            const err = payload as { message: string };
            useSseStore.getState().appendSystem(connectionId, `Error: ${err.message}`);
          },
          close: (payload) => {
            const ev = payload as Partial<SseClosePayload>;
            this.syncStreamState(connectionId, attempt, ev.lastEventId, ev.retry);
            finish({
              message: `Stream closed${ev.reason ? `: ${ev.reason}` : ''}`,
              fatal: ev.fatal === true,
            });
          },
        },
      }
    );

    // Main emits `sse:close` before replying for failures it reports both ways,
    // so a failed reply only lands here when nothing else ended the attempt
    // (policy / rate-limit / SSRF rejections) — none of which a retry fixes.
    session
      .connect()
      .then((res) => {
        if (!res.success) {
          finish({ message: `Failed to connect: ${res.error ?? 'unknown error'}`, fatal: true });
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Connection failed';
        finish({ message: `Failed to connect: ${msg}`, fatal: true });
      });
  }
}

export const sseManager = new SseManager();
