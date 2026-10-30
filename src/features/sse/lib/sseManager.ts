import type { ProxyRequestBody } from '@shared/protocol/proxy-schema';
import { isReconnectableSseResponse } from '@shared/protocol/sse-parser';
import { useSseStore } from '@/features/sse/store/useSseStore';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { executeProxiedStreamingRequest } from '@/lib/shared/transport';
import type { SseClosePayload } from '../../../../electron/types/api/protocols';
import { type ParsedSseEvent, SseParser } from './sseParser';

/**
 * Wire spec for opening an SSE stream through the streaming proxy. Shared by
 * this manager and the store-free `sseStartStream` (`src/features/sse/protocol.ts`)
 * so the streaming shape is defined once. The orchestrator-side timeout is
 * disabled: the caller controls the stream's lifetime with its AbortController.
 */
export function buildSseStreamSpec(url: string, headers: Record<string, string>): ProxyRequestBody {
  return { method: 'GET', url, headers, streamingMode: true, timeout: 0 };
}

/**
 * Remove all `sse:{open,event,error,close}:<connectionId>` IPC listeners.
 * Standalone (not a class method) so both this store-coupled manager and
 * the store-free `sseStartStream`'s Electron path (`src/features/sse/protocol.ts`,
 * used by the DAG executor's sseSubscribe node) share one definition of the
 * channel set instead of each re-listing all four channel names.
 */
export function cleanupSseElectronListeners(
  connectionId: string,
  api: ReturnType<typeof getElectronAPI>
): void {
  api?.sse?.removeAllListeners(`sse:open:${connectionId}`);
  api?.sse?.removeAllListeners(`sse:event:${connectionId}`);
  api?.sse?.removeAllListeners(`sse:error:${connectionId}`);
  api?.sse?.removeAllListeners(`sse:close:${connectionId}`);
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
  autoReconnect: boolean;
  /** Reconnection time in ms — the store default until the server sends `retry:`. */
  retryMs: number;
  /** Reconnects scheduled since the last successful open (capped by `maxReconnectAttempts`). */
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
    if (!url || !url.trim()) return { valid: false, error: 'URL is required' };
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
    options: { reconnectOnResume?: boolean; autoReconnect?: boolean } = {}
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
      this.connectViaElectron(connectionId, session.url, headers, attempt);
      return;
    }
    void this.connectViaProxy(connectionId, session.url, headers, attempt);
  }

  private isCurrent(connectionId: string, attempt: Attempt): boolean {
    return !attempt.ended && this.sessions.get(connectionId)?.attempt === attempt;
  }

  private onOpened(connectionId: string, attempt: Attempt, url: string): void {
    const session = this.sessions.get(connectionId);
    if (!session || !this.isCurrent(connectionId, attempt)) return;
    session.opened = true;
    session.failures = 0;
    const s = useSseStore.getState();
    s.updateConnectionStatus(connectionId, 'connected');
    s.setLastConnectedAt(connectionId, Date.now());
    s.appendSystem(connectionId, `Connected to ${url}`);
  }

  private onEvent(connectionId: string, attempt: Attempt, e: ParsedSseEvent): void {
    if (!this.isCurrent(connectionId, attempt)) return;
    const session = this.sessions.get(connectionId);
    if (session && e.retry !== undefined) session.retryMs = e.retry;
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
    attempt: Attempt
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
        buildSseStreamSpec(url, { Accept: 'text/event-stream', ...headers }),
        { signal: controller.signal }
      );
      clearTimeout(timeoutId);

      if (!response.ok) {
        response.body?.cancel().catch(() => {});
        release();
        this.endAttempt(connectionId, attempt, {
          message: `HTTP ${response.status} ${response.statusText}`,
          fatal: true,
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
    attempt: Attempt
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
      cleanupSseElectronListeners(connectionId, api);
      this.endAttempt(connectionId, attempt, end);
    };

    api.sse.on(`sse:open:${connectionId}`, () => {
      this.onOpened(connectionId, attempt, url);
    });

    api.sse.on(`sse:event:${connectionId}`, (payload: unknown) => {
      this.onEvent(connectionId, attempt, payload as ParsedSseEvent);
    });

    api.sse.on(`sse:error:${connectionId}`, (payload: unknown) => {
      if (!this.isCurrent(connectionId, attempt)) return;
      const err = payload as { message: string };
      useSseStore.getState().appendSystem(connectionId, `Error: ${err.message}`);
    });

    api.sse.on(`sse:close:${connectionId}`, (payload: unknown) => {
      const ev = payload as Partial<SseClosePayload>;
      this.syncStreamState(connectionId, attempt, ev.lastEventId, ev.retry);
      finish({
        message: `Stream closed${ev.reason ? `: ${ev.reason}` : ''}`,
        fatal: ev.fatal === true,
      });
    });

    // Main emits `sse:close` before replying for failures it reports both ways,
    // so a failed reply only lands here when nothing else ended the attempt
    // (policy / rate-limit / SSRF rejections) — none of which a retry fixes.
    api.sse
      .connect({ connectionId, url, headers })
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
