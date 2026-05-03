import { useSseStore } from '@/features/sse/store/useSseStore';
import { isElectron, getElectronAPI } from '@/lib/shared/platform';
import { SseParser, type ParsedSseEvent } from './sseParser';

/**
 * Singleton manager for SSE connections.
 *
 * Three dispatch paths:
 *   1. Electron + IPC — when running in desktop, always (uniform behavior, allows custom headers).
 *   2. fetch + ReadableStream — in web mode when custom headers are set (EventSource doesn't support them).
 *   3. Native EventSource — in web mode without custom headers (cheapest path; native auto-reconnect).
 *
 * Mirrors websocketManager's structure so feature work stays cross-protocol-consistent.
 */
class SseManager {
  /** Native EventSource connections (web, simple-headers path) */
  private esConnections = new Map<string, EventSource>();
  /** AbortControllers for fetch+stream connections (web, custom-headers path) */
  private abortControllers = new Map<string, AbortController>();
  /** Electron-managed connections — no local socket; teardown via IPC */
  private electronConnections = new Set<string>();

  private static DEFAULT_CONNECTION_TIMEOUT = 30000;

  private validateUrl(url: string): { valid: boolean; error?: string } {
    if (!url || !url.trim()) return { valid: false, error: 'URL is required' };
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { valid: false, error: `Invalid protocol "${parsed.protocol}". URL must start with http:// or https://` };
      }
      return { valid: true };
    } catch {
      return { valid: false, error: 'Invalid URL format' };
    }
  }

  connect(connectionId: string, url: string, headers?: Record<string, string>): void {
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

    const lastEventId = store.connections[connectionId]?.lastEventId;
    const reconnectOnResume = store.connections[connectionId]?.reconnectOnResume ?? true;
    const headersWithResume: Record<string, string> = { ...(headers ?? {}) };
    if (reconnectOnResume && lastEventId !== undefined) {
      headersWithResume['Last-Event-ID'] = lastEventId;
    }
    const hasCustomHeaders = Object.keys(headersWithResume).length > 0;

    if (isElectron()) {
      this.connectViaElectron(connectionId, url, headersWithResume);
      return;
    }

    if (hasCustomHeaders) {
      this.connectViaFetch(connectionId, url, headersWithResume);
      return;
    }

    this.connectViaEventSource(connectionId, url);
  }

  disconnect(connectionId: string): void {
    if (this.electronConnections.has(connectionId)) {
      const api = getElectronAPI();
      api?.sse?.disconnect({ connectionId });
      this.electronConnections.delete(connectionId);
      this.cleanupElectronListeners(connectionId, api);
      const s = useSseStore.getState();
      s.updateConnectionStatus(connectionId, 'disconnected');
      s.setReconnectAttempts(connectionId, 0);
      return;
    }

    const es = this.esConnections.get(connectionId);
    if (es) {
      es.close();
      this.esConnections.delete(connectionId);
    }

    const ac = this.abortControllers.get(connectionId);
    if (ac) {
      ac.abort();
      this.abortControllers.delete(connectionId);
    }

    if (es || ac) {
      const s = useSseStore.getState();
      s.updateConnectionStatus(connectionId, 'disconnected');
      s.setReconnectAttempts(connectionId, 0);
    }
  }

  isConnected(connectionId: string): boolean {
    if (this.electronConnections.has(connectionId)) {
      return useSseStore.getState().connections[connectionId]?.status === 'connected';
    }
    const es = this.esConnections.get(connectionId);
    if (es) return es.readyState === EventSource.OPEN;
    return this.abortControllers.has(connectionId);
  }

  cleanup(): void {
    const ids = new Set([
      ...this.esConnections.keys(),
      ...this.abortControllers.keys(),
      ...this.electronConnections,
    ]);
    for (const id of ids) this.disconnect(id);
  }

  // ---------------------------------------------------------------- private

  private connectViaEventSource(connectionId: string, url: string): void {
    const store = useSseStore.getState();
    try {
      const es = new EventSource(url);
      this.esConnections.set(connectionId, es);

      es.onopen = () => {
        const s = useSseStore.getState();
        s.updateConnectionStatus(connectionId, 'connected');
        s.setLastConnectedAt(connectionId, Date.now());
        s.appendSystem(connectionId, `Connected to ${url}`);
      };

      es.onmessage = (e) => {
        const s = useSseStore.getState();
        s.appendEvent(connectionId, {
          event: 'message',
          data: e.data,
          ...(e.lastEventId ? { lastEventId: e.lastEventId } : {}),
        });
      };

      es.onerror = () => {
        const s = useSseStore.getState();
        s.appendSystem(connectionId, 'Stream error');
        // EventSource auto-reconnects; reflect that in status
        if (es.readyState === EventSource.CONNECTING) {
          s.updateConnectionStatus(connectionId, 'reconnecting');
        } else if (es.readyState === EventSource.CLOSED) {
          s.updateConnectionStatus(connectionId, 'disconnected');
          this.esConnections.delete(connectionId);
        }
      };
    } catch (error) {
      store.updateConnectionStatus(connectionId, 'disconnected');
      store.appendSystem(connectionId, `Failed to connect: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async connectViaFetch(connectionId: string, url: string, headers: Record<string, string>): Promise<void> {
    const store = useSseStore.getState();
    const controller = new AbortController();
    this.abortControllers.set(connectionId, controller);

    const timeoutId = setTimeout(() => {
      controller.abort();
    }, SseManager.DEFAULT_CONNECTION_TIMEOUT);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', ...headers },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        store.appendSystem(connectionId, `HTTP ${response.status} ${response.statusText}`);
        store.updateConnectionStatus(connectionId, 'disconnected');
        this.abortControllers.delete(connectionId);
        return;
      }
      if (!response.body) {
        store.appendSystem(connectionId, 'No response body');
        store.updateConnectionStatus(connectionId, 'disconnected');
        this.abortControllers.delete(connectionId);
        return;
      }

      store.updateConnectionStatus(connectionId, 'connected');
      store.setLastConnectedAt(connectionId, Date.now());
      store.appendSystem(connectionId, `Connected to ${url}`);

      const decoder = new TextDecoder();
      const parser = new SseParser();
      const reader = response.body.getReader();
      const onEvent = (e: ParsedSseEvent) => {
        const s = useSseStore.getState();
        s.appendEvent(connectionId, {
          event: e.event,
          data: e.data,
          ...(e.lastEventId !== undefined ? { lastEventId: e.lastEventId } : {}),
          ...(e.retry !== undefined ? { retry: e.retry } : {}),
        });
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }), onEvent);
      }
      parser.feed(decoder.decode(), onEvent);

      const s = useSseStore.getState();
      s.appendSystem(connectionId, 'Stream closed');
      s.updateConnectionStatus(connectionId, 'disconnected');
      this.abortControllers.delete(connectionId);
    } catch (error) {
      clearTimeout(timeoutId);
      this.abortControllers.delete(connectionId);
      const s = useSseStore.getState();
      if (controller.signal.aborted) {
        s.appendSystem(connectionId, 'Stream aborted');
      } else {
        s.appendSystem(connectionId, `Stream error: ${error instanceof Error ? error.message : 'Unknown'}`);
      }
      s.updateConnectionStatus(connectionId, 'disconnected');
    }
  }

  private connectViaElectron(connectionId: string, url: string, headers: Record<string, string>): void {
    const store = useSseStore.getState();
    const api = getElectronAPI();
    if (!api?.sse) {
      store.appendSystem(connectionId, 'Electron SSE API not available');
      store.updateConnectionStatus(connectionId, 'disconnected');
      return;
    }

    // Always clear any prior listeners for this id before re-registering — otherwise
    // a retry after a failed connect leaves stale handlers that fire on the next event.
    this.cleanupElectronListeners(connectionId, api);

    api.sse.on(`sse:open:${connectionId}`, () => {
      const s = useSseStore.getState();
      s.updateConnectionStatus(connectionId, 'connected');
      s.setLastConnectedAt(connectionId, Date.now());
      s.appendSystem(connectionId, `Connected to ${url}`);
      this.electronConnections.add(connectionId);
    });

    api.sse.on(`sse:event:${connectionId}`, (payload: unknown) => {
      const e = payload as ParsedSseEvent;
      const s = useSseStore.getState();
      s.appendEvent(connectionId, {
        event: e.event,
        data: e.data,
        ...(e.lastEventId !== undefined ? { lastEventId: e.lastEventId } : {}),
        ...(e.retry !== undefined ? { retry: e.retry } : {}),
      });
    });

    api.sse.on(`sse:error:${connectionId}`, (payload: unknown) => {
      const err = payload as { message: string };
      useSseStore.getState().appendSystem(connectionId, `Error: ${err.message}`);
    });

    api.sse.on(`sse:close:${connectionId}`, (payload: unknown) => {
      const ev = payload as { reason?: string };
      const s = useSseStore.getState();
      s.appendSystem(connectionId, `Stream closed${ev.reason ? `: ${ev.reason}` : ''}`);
      s.updateConnectionStatus(connectionId, 'disconnected');
      this.electronConnections.delete(connectionId);
      this.cleanupElectronListeners(connectionId, api);
    });

    api.sse.connect({ connectionId, url, headers }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Connection failed';
      const s = useSseStore.getState();
      s.appendSystem(connectionId, `Failed to connect: ${msg}`);
      s.updateConnectionStatus(connectionId, 'disconnected');
      this.electronConnections.delete(connectionId);
      this.cleanupElectronListeners(connectionId, api);
    });
  }

  private cleanupElectronListeners(connectionId: string, api: ReturnType<typeof getElectronAPI>): void {
    api?.sse?.removeAllListeners(`sse:open:${connectionId}`);
    api?.sse?.removeAllListeners(`sse:event:${connectionId}`);
    api?.sse?.removeAllListeners(`sse:error:${connectionId}`);
    api?.sse?.removeAllListeners(`sse:close:${connectionId}`);
  }
}

export const sseManager = new SseManager();
