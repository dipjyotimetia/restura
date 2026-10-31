import {
  decodeWsBinaryFrame,
  encodeWsBinaryFrame,
  WS_IPC_MAX_MESSAGE_LENGTH,
} from '@shared/protocol/ws-binary-codec';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import { checkBrowserSocketTargetFromSettings } from '@/lib/shared/browserSocketPolicy';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { EVENT_PREFIX, eventChannel } from '../../../../electron/shared/channels';
import {
  attachControlFrameListeners,
  clearPingRtt,
  controlFrameChannels,
  describeClose,
  recordNegotiation,
  sendElectronPing,
  WEB_PING_UNSUPPORTED,
  type WsCloseOptions,
} from './wsControlFrames';

/**
 * Remove all `ws:{open,message,error,close}:<connectionId>` IPC listeners and
 * the control-frame ones, by connection id so a reconnect or `disconnect()`
 * clears whatever an earlier attempt left on the same id.
 */
export function cleanupWebSocketElectronListeners(
  connectionId: string,
  api: ReturnType<typeof getElectronAPI>
): void {
  api?.websocket?.removeAllListeners(eventChannel(EVENT_PREFIX.ws.open, connectionId));
  api?.websocket?.removeAllListeners(eventChannel(EVENT_PREFIX.ws.message, connectionId));
  api?.websocket?.removeAllListeners(eventChannel(EVENT_PREFIX.ws.error, connectionId));
  api?.websocket?.removeAllListeners(eventChannel(EVENT_PREFIX.ws.close, connectionId));
  for (const channel of controlFrameChannels(connectionId)) {
    api?.websocket?.removeAllListeners(channel);
  }
}

interface ConnectArgs {
  url: string;
  protocols?: string[] | undefined;
  headers?: Record<string, string> | undefined;
}

// Singleton manager for WebSocket connections
class WebSocketManager {
  private connections: Map<string, WebSocket> = new Map();
  private electronConnections: Set<string> = new Set();
  private reconnectTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private connectionTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private heartbeatIntervals: Map<string, NodeJS.Timeout> = new Map();
  /** Args of the last connect, replayed verbatim by auto-reconnect (#902). */
  private connectArgs: Map<string, ConnectArgs> = new Map();
  /** Token of the live desktop attempt; stale IPC events/results are ignored (#908). */
  private electronAttempts: Map<string, symbol> = new Map();
  /** Pending "connection stayed open long enough" timers that reset the retry counter. */
  private stabilityTimers: Map<string, NodeJS.Timeout> = new Map();
  private static DEFAULT_CONNECTION_TIMEOUT = 30000; // 30 seconds
  /** An open connection must survive this long before the reconnect counter resets. */
  private static STABLE_OPEN_MS = 10_000;

  /**
   * Close codes that retrying cannot fix: 1008 (policy violation) and 4400-4499
   * (app-level client errors, e.g. 4401 unauthorized / 4403 forbidden).
   */
  private static isTerminalCloseCode(code: number): boolean {
    return code === 1008 || (code >= 4400 && code <= 4499);
  }

  private clearStabilityTimer(connectionId: string): void {
    const t = this.stabilityTimers.get(connectionId);
    if (t) {
      clearTimeout(t);
      this.stabilityTimers.delete(connectionId);
    }
  }

  private validateUrl(url: string): { valid: boolean; error?: string } {
    if (!url || !url.trim()) {
      return { valid: false, error: 'URL is required' };
    }

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        return {
          valid: false,
          error: `Invalid protocol "${parsed.protocol}". URL must start with ws:// or wss://`,
        };
      }
      return { valid: true };
    } catch {
      return { valid: false, error: 'Invalid URL format' };
    }
  }

  connect(
    connectionId: string,
    url: string,
    protocols?: string[],
    headers?: Record<string, string>
  ): void {
    this.open(connectionId, { url, protocols, headers }, false);
  }

  /** `isReconnect` keeps the attempt counter so maxReconnectAttempts is honoured. */
  private open(connectionId: string, args: ConnectArgs, isReconnect: boolean): void {
    const { url, protocols, headers } = args;
    // Close existing connection if any. A manual connect also cancels a pending
    // reconnect timer, which would otherwise later replace this connection.
    this.disconnect(connectionId, !isReconnect);
    this.connectArgs.set(connectionId, args);

    const store = useWebSocketStore.getState();

    // Validate URL before attempting connection
    const validation = this.validateUrl(url);
    if (!validation.valid) {
      store.addMessage(connectionId, 'system', `Connection failed: ${validation.error}`);
      store.updateConnectionStatus(connectionId, 'disconnected');
      return;
    }

    // Desktop always uses the IPC bridge (`ws` in the main process): the
    // renderer's CSP forbids direct ws: connections in the packaged app, and
    // the main-process path adds custom headers + the DNS-pinned SSRF guard.
    if (isElectron()) {
      this.connectViaElectron(connectionId, url, headers ?? {}, protocols, isReconnect);
      return;
    }

    // Browser-direct: the Worker's SSRF guard never sees this socket (#898).
    const target = checkBrowserSocketTargetFromSettings(url);
    if (!target.ok) {
      store.addMessage(connectionId, 'system', `Connection refused: ${target.error}`);
      store.updateConnectionStatus(connectionId, 'disconnected');
      return;
    }

    store.updateConnectionStatus(connectionId, 'connecting');
    if (!isReconnect) store.setReconnectAttempts(connectionId, 0);

    // Browser path: the WebSocket API has no handshake-header support, so any
    // configured headers are silently unusable here — say so instead of
    // letting an Authorization header vanish without a trace.
    if (headers && Object.keys(headers).length > 0) {
      store.addMessage(
        connectionId,
        'system',
        'Custom handshake headers are not supported by the browser WebSocket API and were NOT sent. Use the desktop app to send handshake headers.'
      );
    }

    try {
      const ws = protocols?.length ? new WebSocket(url, protocols) : new WebSocket(url);

      // Set connection timeout
      const timeoutId = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.close();
          store.addMessage(
            connectionId,
            'system',
            `Connection timeout after ${WebSocketManager.DEFAULT_CONNECTION_TIMEOUT / 1000}s`
          );
          store.updateConnectionStatus(connectionId, 'disconnected');
          this.connections.delete(connectionId);
          this.connectionTimeouts.delete(connectionId);
          this.connectArgs.delete(connectionId);
        }
      }, WebSocketManager.DEFAULT_CONNECTION_TIMEOUT);

      this.connectionTimeouts.set(connectionId, timeoutId);

      // Set binary type to arraybuffer for binary message support
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        // Clear connection timeout
        const timeout = this.connectionTimeouts.get(connectionId);
        if (timeout) {
          clearTimeout(timeout);
          this.connectionTimeouts.delete(connectionId);
        }

        this.handleOpen(connectionId, url, ws.protocol, ws.extensions);
      };

      ws.onmessage = (event) => {
        const state = useWebSocketStore.getState();

        if (event.data instanceof ArrayBuffer) {
          // Binary message
          const hexString = this.arrayBufferToHex(event.data);
          state.addMessage(connectionId, 'received', hexString, 'binary', event.data);
        } else {
          // Text message
          state.addMessage(connectionId, 'received', event.data, 'text');
        }
      };

      ws.onerror = (error) => {
        const state = useWebSocketStore.getState();
        state.addMessage(connectionId, 'system', 'WebSocket error occurred');
        console.error('WebSocket error:', error);
      };

      ws.onclose = (event) => {
        this.connections.delete(connectionId);
        this.handleClose(connectionId, event.code, event.reason);
      };

      this.connections.set(connectionId, ws);
    } catch (error) {
      const state = useWebSocketStore.getState();
      state.updateConnectionStatus(connectionId, 'disconnected');
      state.addMessage(
        connectionId,
        'system',
        `Failed to connect: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /** `close` (#915): optional RFC 6455 close code/reason; default 1000 "Client disconnected". */
  disconnect(connectionId: string, clearReconnect = true, close?: WsCloseOptions): void {
    clearPingRtt(connectionId);
    this.clearStabilityTimer(connectionId);
    // Clear any pending reconnect
    if (clearReconnect) {
      // Drop the resolved url/headers (may hold credentials) — nothing will replay them.
      this.connectArgs.delete(connectionId);
      const timeout = this.reconnectTimeouts.get(connectionId);
      if (timeout) {
        clearTimeout(timeout);
        this.reconnectTimeouts.delete(connectionId);
        // Nothing else is live while waiting to reconnect; settle the UI.
        const state = useWebSocketStore.getState();
        state.updateConnectionStatus(connectionId, 'disconnected');
        state.setReconnectAttempts(connectionId, 0);
      }
    }

    // Clear connection timeout
    const connectionTimeout = this.connectionTimeouts.get(connectionId);
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
      this.connectionTimeouts.delete(connectionId);
    }

    this.stopHeartbeat(connectionId);

    // Handle Electron-managed connections — tracked from connectViaElectron,
    // so this also aborts an in-flight handshake (#908).
    if (this.electronConnections.has(connectionId)) {
      const api = getElectronAPI();
      api?.websocket?.disconnect({ connectionId, ...close });
      this.releaseElectron(connectionId, api);
      const state = useWebSocketStore.getState();
      if (close) state.addMessage(connectionId, 'system', describeClose(close));
      state.updateConnectionStatus(connectionId, 'disconnected');
      state.setReconnectAttempts(connectionId, 0);
      return;
    }

    const ws = this.connections.get(connectionId);
    if (ws) {
      ws.onclose = null; // Prevent reconnect on intentional close
      if (close) ws.close(close.code, close.reason ?? '');
      else ws.close(1000, 'Client disconnected');
      this.connections.delete(connectionId);

      const state = useWebSocketStore.getState();
      if (close) state.addMessage(connectionId, 'system', describeClose(close));
      state.updateConnectionStatus(connectionId, 'disconnected');
      state.setReconnectAttempts(connectionId, 0);
    }
  }

  /**
   * `options.display` overrides the transcript copy of a sent frame — used to
   * keep resolved secret `{{var}}` values out of the message log (#927).
   */
  send(
    connectionId: string,
    message: string | ArrayBuffer,
    options: { display?: string } = {}
  ): boolean {
    // Handle Electron-managed connections
    if (this.electronConnections.has(connectionId)) {
      const api = getElectronAPI();
      if (!api?.websocket) return false;

      const state = useWebSocketStore.getState();
      if (message instanceof ArrayBuffer) {
        // IPC carries base64 (shared codec, same as main); hex is display-only.
        const encoded = encodeWsBinaryFrame(message);
        if (encoded.length > WS_IPC_MAX_MESSAGE_LENGTH) {
          // Main's ws:send schema would reject it silently — refuse up front.
          state.addMessage(
            connectionId,
            'system',
            `Binary frame too large to send (${message.byteLength} bytes; desktop limit is ${(WS_IPC_MAX_MESSAGE_LENGTH / 4) * 3} bytes)`
          );
          return false;
        }
        const hexString = this.arrayBufferToHex(message);
        api.websocket.send({ connectionId, message: encoded, binary: true });
        state.addMessage(connectionId, 'sent', options.display ?? hexString, 'binary', message);
      } else {
        api.websocket.send({ connectionId, message });
        state.addMessage(connectionId, 'sent', options.display ?? message, 'text');
      }
      return true;
    }

    const ws = this.connections.get(connectionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(message);

      const state = useWebSocketStore.getState();
      if (message instanceof ArrayBuffer) {
        const hexString = this.arrayBufferToHex(message);
        state.addMessage(connectionId, 'sent', options.display ?? hexString, 'binary', message);
      } else {
        state.addMessage(connectionId, 'sent', options.display ?? message, 'text');
      }
      return true;
    }
    return false;
  }

  /** Send a Ping control frame (#919). Desktop only — browsers expose no ping API. */
  ping(connectionId: string, payload: string): boolean {
    if (!this.electronConnections.has(connectionId)) {
      useWebSocketStore.getState().addMessage(connectionId, 'system', WEB_PING_UNSUPPORTED);
      return false;
    }
    return sendElectronPing(connectionId, payload, getElectronAPI());
  }

  getConnection(connectionId: string): WebSocket | undefined {
    return this.connections.get(connectionId);
  }

  isConnected(connectionId: string): boolean {
    if (this.electronConnections.has(connectionId)) {
      return useWebSocketStore.getState().connections[connectionId]?.status === 'connected';
    }
    const ws = this.connections.get(connectionId);
    return ws?.readyState === WebSocket.OPEN;
  }

  private connectViaElectron(
    connectionId: string,
    url: string,
    headers: Record<string, string>,
    protocols: string[] | undefined,
    isReconnect: boolean
  ): void {
    const store = useWebSocketStore.getState();
    const api = getElectronAPI();
    if (!api?.websocket) {
      store.addMessage(connectionId, 'system', 'Electron WebSocket API not available');
      store.updateConnectionStatus(connectionId, 'disconnected');
      return;
    }

    store.updateConnectionStatus(connectionId, 'connecting');
    if (!isReconnect) store.setReconnectAttempts(connectionId, 0);

    // Electron-managed from the start (not from ws:open) so a Disconnect during
    // the handshake reaches main; the token drops events of stale attempts.
    const attempt = Symbol(connectionId);
    this.electronConnections.add(connectionId);
    this.electronAttempts.set(connectionId, attempt);
    const isLive = () => this.electronAttempts.get(connectionId) === attempt;

    api.websocket.on(eventChannel(EVENT_PREFIX.ws.open, connectionId), (payload: unknown) => {
      // #923: main forwards the negotiated subprotocol + extensions.
      const open = (payload ?? {}) as { protocol?: string; extensions?: string };
      if (isLive()) this.handleOpen(connectionId, url, open.protocol, open.extensions);
    });

    attachControlFrameListeners(connectionId, api);

    api.websocket.on(eventChannel(EVENT_PREFIX.ws.message, connectionId), (payload: unknown) => {
      const msg = payload as { type: 'text' | 'binary'; data: string };
      const s = useWebSocketStore.getState();
      if (msg.type === 'binary') {
        let buf: ArrayBuffer;
        try {
          buf = decodeWsBinaryFrame(msg.data).buffer;
        } catch {
          s.addMessage(connectionId, 'system', 'Received a malformed binary frame payload');
          return;
        }
        s.addMessage(connectionId, 'received', this.arrayBufferToHex(buf), 'binary', buf);
      } else {
        s.addMessage(connectionId, 'received', msg.data, 'text');
      }
    });

    api.websocket.on(eventChannel(EVENT_PREFIX.ws.error, connectionId), (payload: unknown) => {
      const err = payload as { message: string };
      useWebSocketStore.getState().addMessage(connectionId, 'system', `Error: ${err.message}`);
    });

    api.websocket.on(eventChannel(EVENT_PREFIX.ws.close, connectionId), (payload: unknown) => {
      if (!isLive()) return;
      const ev = payload as { code: number; reason: string };
      this.releaseElectron(connectionId, api);
      this.handleClose(connectionId, ev.code, ev.reason);
    });

    const fail = (errMsg: string) => {
      if (!isLive()) return;
      this.releaseElectron(connectionId, api);
      const s = useWebSocketStore.getState();
      s.addMessage(connectionId, 'system', `Failed to connect: ${errMsg}`);
      // A rejected first connect is final (policy/SSRF); a rejected reconnect
      // (e.g. transient DNS failure) continues the backoff loop like a 1006.
      if (isReconnect) this.handleClose(connectionId, 1006, '', false);
      else {
        this.connectArgs.delete(connectionId);
        s.updateConnectionStatus(connectionId, 'disconnected');
      }
    };

    api.websocket
      .connect({
        connectionId,
        url,
        headers,
        ...(protocols !== undefined ? { protocols } : {}),
        // #923: desktop-only toggle; unset means the `ws` default (offered).
        ...(store.connections[connectionId]?.perMessageDeflate === false
          ? { perMessageDeflate: false }
          : {}),
      })
      .then((res) => {
        if (res && !res.success) fail(res.error ?? 'Connection failed');
      })
      .catch((err: unknown) => fail(err instanceof Error ? err.message : 'Connection failed'));
  }

  private releaseElectron(connectionId: string, api: ReturnType<typeof getElectronAPI>): void {
    this.electronConnections.delete(connectionId);
    this.electronAttempts.delete(connectionId);
    cleanupWebSocketElectronListeners(connectionId, api);
  }

  /**
   * Transport-agnostic open: status, counters and heartbeat for both paths,
   * plus the negotiated subprotocol / extensions (#923).
   */
  private handleOpen(
    connectionId: string,
    url: string,
    protocol: string | undefined,
    extensions: string | undefined
  ): void {
    const state = useWebSocketStore.getState();
    state.updateConnectionStatus(connectionId, 'connected');
    // Reset the retry budget only once the connection proves stable; a server
    // that accepts then immediately closes must still exhaust maxReconnectAttempts.
    this.clearStabilityTimer(connectionId);
    this.stabilityTimers.set(
      connectionId,
      setTimeout(() => {
        this.stabilityTimers.delete(connectionId);
        useWebSocketStore.getState().setReconnectAttempts(connectionId, 0);
      }, WebSocketManager.STABLE_OPEN_MS)
    );
    state.setLastConnectedAt(connectionId, Date.now());
    const negotiated = recordNegotiation(connectionId, protocol, extensions);
    state.addMessage(connectionId, 'system', `Connected to ${url}${negotiated}`);

    const conn = state.connections[connectionId];
    if (conn && conn.heartbeatInterval > 0) {
      this.startHeartbeat(connectionId, conn.heartbeatInterval, conn.heartbeatMessage);
    }
  }

  /**
   * Transport-agnostic unexpected close: reconnect per the connection's
   * settings or settle disconnected. User disconnects never get here — the
   * browser path nulls `onclose`, the IPC path removes its listeners first.
   */
  private handleClose(connectionId: string, code: number, reason: string, log = true): void {
    this.stopHeartbeat(connectionId);
    this.clearStabilityTimer(connectionId);
    clearPingRtt(connectionId);
    const state = useWebSocketStore.getState();
    const connection = state.connections[connectionId];
    if (log) {
      state.addMessage(
        connectionId,
        'system',
        `Connection closed (code: ${code}, reason: ${reason || 'No reason provided'})`
      );
    }
    const terminal = WebSocketManager.isTerminalCloseCode(code);
    if (terminal && connection?.autoReconnect) {
      state.addMessage(
        connectionId,
        'system',
        `Not reconnecting: close code ${code} is a policy/client error that retrying cannot fix`
      );
    }
    if (
      connection?.autoReconnect &&
      !terminal &&
      code !== 1000 && // Normal closure
      code !== 1001 && // Going away
      connection.reconnectAttempts < connection.maxReconnectAttempts
    ) {
      this.scheduleReconnect(connectionId);
    } else {
      // Terminal: nothing will replay the resolved url/headers (may hold credentials).
      this.connectArgs.delete(connectionId);
      state.updateConnectionStatus(connectionId, 'disconnected');
    }
  }

  /** Sends a heartbeat over whichever transport owns the connection. */
  private sendHeartbeat(connectionId: string, message: string): boolean {
    if (this.electronConnections.has(connectionId)) {
      const api = getElectronAPI();
      if (!api?.websocket || !this.isConnected(connectionId)) return false;
      // A rejected IPC send means the bridge is gone; stop instead of leaking rejections.
      api.websocket.send({ connectionId, message }).catch(() => this.stopHeartbeat(connectionId));
      return true;
    }
    const ws = this.connections.get(connectionId);
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(message);
    return true;
  }

  private startHeartbeat(connectionId: string, interval: number, message: string): void {
    this.stopHeartbeat(connectionId);
    const id = setInterval(() => {
      if (!this.sendHeartbeat(connectionId, message)) this.stopHeartbeat(connectionId);
    }, interval);
    this.heartbeatIntervals.set(connectionId, id);
  }

  private stopHeartbeat(connectionId: string): void {
    const id = this.heartbeatIntervals.get(connectionId);
    if (id !== undefined) {
      clearInterval(id);
      this.heartbeatIntervals.delete(connectionId);
    }
  }

  private scheduleReconnect(connectionId: string): void {
    const state = useWebSocketStore.getState();
    const connection = state.connections[connectionId];
    if (!connection) return;

    const attempts = connection.reconnectAttempts + 1;
    state.setReconnectAttempts(connectionId, attempts);
    state.updateConnectionStatus(connectionId, 'reconnecting');

    // Exponential backoff with jitter
    const baseDelay = connection.reconnectDelay;
    const delay = Math.min(
      baseDelay * Math.pow(2, attempts - 1) + Math.random() * 1000,
      30000 // Max 30 seconds
    );

    state.addMessage(
      connectionId,
      'system',
      `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempts}/${connection.maxReconnectAttempts})`
    );

    const timeout = setTimeout(() => {
      this.reconnectTimeouts.delete(connectionId);
      // Replay the original (already variable-resolved) url, protocols and
      // headers — desktop handshake headers must survive a reconnect.
      const args = this.connectArgs.get(connectionId);
      if (args && useWebSocketStore.getState().connections[connectionId]) {
        this.open(connectionId, args, true);
      }
    }, delay);

    this.reconnectTimeouts.set(connectionId, timeout);
  }

  private arrayBufferToHex(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
  }

  /**
   * Parse a whitespace-separated hex string (the binary compose format) into an
   * ArrayBuffer for sending. Each token may carry an optional `0x`/`0X` prefix.
   * Throws on any token that is not whole hex bytes (e.g. `zz`, `123`) so
   * nothing malformed is ever sent (#912).
   */
  hexToArrayBuffer(hex: string): ArrayBuffer {
    const bytes: number[] = [];
    for (const token of hex.split(/\s+/).filter((s) => s.length > 0)) {
      const digits = token.replace(/^0x/i, '');
      if (!/^(?:[0-9a-f]{2})+$/i.test(digits)) {
        throw new Error(
          `Invalid hex token "${token}" (expected whole bytes, optional 0x prefix, e.g. "48" or "0x48")`
        );
      }
      for (let i = 0; i < digits.length; i += 2) bytes.push(parseInt(digits.slice(i, i + 2), 16));
    }
    return new Uint8Array(bytes).buffer;
  }

  cleanup(): void {
    for (const [connectionId] of this.connections) {
      this.disconnect(connectionId);
    }
  }

  updateHeartbeat(connectionId: string, interval: number, message: string): void {
    this.stopHeartbeat(connectionId);
    if (interval > 0 && this.isConnected(connectionId)) {
      this.startHeartbeat(connectionId, interval, message);
    }
  }
}

// Export singleton instance
export const websocketManager = new WebSocketManager();
