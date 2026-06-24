import { SseParser, type ParsedSseEvent } from './sseParser';
import { useSseStore } from '@/features/sse/store/useSseStore';
import { isElectron, getElectronAPI } from '@/lib/shared/platform';
import { executeProxiedStreamingRequest } from '@/lib/shared/transport';

// Singleton SSE manager. Desktop → `sse:connect` IPC. Web → proxied
// stream via `/api/proxy`. Native EventSource and direct fetch are
// intentionally absent — they bypassed the Worker's SSRF / header / auth
// guards.
class SseManager {
  /** AbortControllers for proxied web connections — abort closes the fetch stream. */
  private webConnections = new Map<string, AbortController>();
  /** Electron-managed connections — no local socket; teardown via IPC. */
  private electronConnections = new Set<string>();

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

    if (isElectron()) {
      this.connectViaElectron(connectionId, url, headersWithResume);
      return;
    }

    void this.connectViaProxy(connectionId, url, headersWithResume);
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

    const ac = this.webConnections.get(connectionId);
    if (ac) {
      ac.abort();
      this.webConnections.delete(connectionId);
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
    const ids = new Set([...this.webConnections.keys(), ...this.electronConnections]);
    for (const id of ids) this.disconnect(id);
  }

  // ---------------------------------------------------------------- private

  private async connectViaProxy(
    connectionId: string,
    url: string,
    headers: Record<string, string>
  ): Promise<void> {
    const store = useSseStore.getState();
    const controller = new AbortController();
    this.webConnections.set(connectionId, controller);

    const timeoutId = setTimeout(() => {
      controller.abort();
    }, SseManager.DEFAULT_CONNECTION_TIMEOUT);

    try {
      // signal goes through to fetch so abort during the request/connect
      // phase actually closes the socket — not just the body afterward.
      const response = await executeProxiedStreamingRequest(
        {
          method: 'GET',
          url,
          headers: { Accept: 'text/event-stream', ...headers },
          streamingMode: true,
          // Orchestrator-side timeout disabled; the renderer controls
          // lifetime via the AbortController above.
          timeout: 0,
        },
        { signal: controller.signal }
      );
      clearTimeout(timeoutId);

      if (!response.ok) {
        store.appendSystem(connectionId, `HTTP ${response.status} ${response.statusText}`);
        store.updateConnectionStatus(connectionId, 'disconnected');
        this.webConnections.delete(connectionId);
        return;
      }
      if (!response.body) {
        store.appendSystem(connectionId, 'No response body');
        store.updateConnectionStatus(connectionId, 'disconnected');
        this.webConnections.delete(connectionId);
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
      this.webConnections.delete(connectionId);
    } catch (error) {
      clearTimeout(timeoutId);
      this.webConnections.delete(connectionId);
      const s = useSseStore.getState();
      if (controller.signal.aborted) {
        s.appendSystem(connectionId, 'Stream aborted');
      } else {
        s.appendSystem(
          connectionId,
          `Stream error: ${error instanceof Error ? error.message : 'Unknown'}`
        );
      }
      s.updateConnectionStatus(connectionId, 'disconnected');
    }
  }

  private connectViaElectron(
    connectionId: string,
    url: string,
    headers: Record<string, string>
  ): void {
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

  private cleanupElectronListeners(
    connectionId: string,
    api: ReturnType<typeof getElectronAPI>
  ): void {
    api?.sse?.removeAllListeners(`sse:open:${connectionId}`);
    api?.sse?.removeAllListeners(`sse:event:${connectionId}`);
    api?.sse?.removeAllListeners(`sse:error:${connectionId}`);
    api?.sse?.removeAllListeners(`sse:close:${connectionId}`);
  }
}

export const sseManager = new SseManager();
