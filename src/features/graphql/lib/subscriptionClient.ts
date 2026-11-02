import { type Client, createClient, type Sink } from 'graphql-ws';
import { isElectron } from '@/lib/shared/platform';
import type { GraphQLSubscriptionProtocol } from '@/types';
import {
  createElectronGraphQLSocketClass,
  type MainSideHandshakeAuth,
} from './electronGraphQLSocket';
import { subscribeGraphQLSse } from './graphqlSseSubscription';
import { runLegacyWsSubscription } from './legacyWsSubscription';
import {
  AUTO_SUBPROTOCOLS,
  assertBrowserSocketTargetAllowed,
  assertWebSocketUrl,
  describeSubscriptionError,
  GRAPHQL_TRANSPORT_WS_SUBPROTOCOL,
  LEGACY_GRAPHQL_WS_SUBPROTOCOL,
  openSubscriptionSocket,
  SOCKET_OPEN,
  type SubscriptionSink,
  type SubscriptionSocket,
  toWebSocketUrl,
} from './subscriptionSocket';

export interface SubscriptionMessage {
  id: string;
  type: 'data' | 'error' | 'complete' | 'connecting' | 'connected';
  payload?: unknown;
  error?: string;
  /** On `connected`: the negotiated wire protocol (e.g. `graphql-ws`, `graphql-sse`). */
  protocol?: string;
  timestamp: number;
}

export interface SubscriptionOptions {
  url: string;
  query: string;
  variables?: Record<string, unknown>;
  /**
   * Operation to run in a multi-operation document, sent in the subscribe
   * payload of every protocol (servers require it to pick an operation,
   * GraphQL §6.1). Null/omitted for single or anonymous operations.
   */
  operationName?: string | null;
  headers?: Record<string, string>;
  /** Wire protocol; defaults to `auto` (negotiate between the two WS subprotocols). */
  protocol?: GraphQLSubscriptionProtocol;
  onMessage: (msg: SubscriptionMessage) => void;
  onConnected?: () => void;
  onError?: (err: unknown) => void;
  onComplete?: () => void;
}

export interface SubscriptionClientOptions {
  /**
   * `connection_init` payload (both WS protocols). Defaults to `headers`. Never
   * carries credentials resolved main-side — the renderer has no plaintext.
   */
  connectionParams?: Record<string, string>;
  /**
   * Desktop: auth / secret-variable refs Electron main resolves into the
   * transport (WS handshake headers, or graphql-sse request headers) —
   * ADR-0007, #878/#882.
   */
  mainSide?: MainSideHandshakeAuth;
  /** graphql-sse: auth-added header names, removed on a redirect to another origin. */
  stripOnOriginChange?: string[];
}

const CONNECT_TIMEOUT_MS = 30_000;

const makeId = (): string => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * Runs one GraphQL subscription over the selected protocol (#889):
 *
 * - `graphql-transport-ws` — the `graphql-ws` SDK client.
 * - `subscriptions-transport-ws` — hand-rolled legacy Apollo client (`legacyWsSubscription`).
 * - `graphql-sse` — distinct-connections GraphQL over SSE (`graphqlSseSubscription`).
 * - `auto` — one WebSocket offering both subprotocols; dispatch on the server's pick
 *   (an empty pick falls back to graphql-transport-ws).
 *
 * Handshake headers ride the WebSocket upgrade on desktop (IPC bridge) and are
 * also sent as connection params; graphql-sse sends them as HTTP headers.
 */
export class GraphQLSubscriptionClient {
  private client: Client | null = null;
  private unsubscribe: (() => void) | null = null;
  private headers: Record<string, string>;
  private initParams: Record<string, string>;
  private mainSide: MainSideHandshakeAuth | undefined;
  private stripOnOriginChange: string[] | undefined;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private negotiating: SubscriptionSocket | null = null;
  /** Bumped per connect/disconnect so a superseded run's late events are dropped. */
  private generation = 0;

  constructor(
    _url: string,
    headers: Record<string, string> = {},
    options: SubscriptionClientOptions = {}
  ) {
    this.headers = headers;
    this.initParams = options.connectionParams ?? headers;
    this.mainSide = options.mainSide;
    this.stripOnOriginChange = options.stripOnOriginChange;
  }

  connect(options: SubscriptionOptions): void {
    this.disconnect();

    options.onMessage({ id: makeId(), type: 'connecting', timestamp: Date.now() });

    const sink = this.createSink(options);
    this.timeoutId = setTimeout(() => {
      this.timeoutId = null;
      sink.error(new Error('Connection timeout'));
    }, CONNECT_TIMEOUT_MS);
    try {
      this.start(options, sink);
    } catch (err) {
      // e.g. the browser WebSocket constructor throws a SyntaxError on a
      // malformed / unresolved-{{var}} URL — fail now, not at the 30 s timeout.
      sink.error(err);
    }
  }

  private start(options: SubscriptionOptions, sink: SubscriptionSink): void {
    const protocol = options.protocol ?? 'auto';

    switch (protocol) {
      case 'graphql-transport-ws':
        this.runTransportWs(options, sink);
        return;
      case 'subscriptions-transport-ws':
        this.unsubscribe = runLegacyWsSubscription(
          openSubscriptionSocket(
            toWebSocketUrl(options.url),
            [LEGACY_GRAPHQL_WS_SUBPROTOCOL],
            this.headers,
            this.mainSide
          ),
          { ...this.operation(options), ...this.connectionParams() },
          sink
        );
        return;
      case 'graphql-sse':
        this.unsubscribe = subscribeGraphQLSse(
          {
            url: options.url,
            headers: this.headers,
            ...(this.mainSide ? { mainSide: this.mainSide } : {}),
            ...(this.stripOnOriginChange ? { stripOnOriginChange: this.stripOnOriginChange } : {}),
            ...this.operation(options),
          },
          sink
        );
        return;
      default:
        this.negotiate(options, sink);
    }
  }

  disconnect(): void {
    this.generation++;
    this.clearTimer();
    if (this.negotiating) {
      const socket = this.negotiating;
      this.negotiating = null;
      socket.onopen = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.client?.dispose();
    this.client = null;
  }

  get isConnected(): boolean {
    return this.unsubscribe !== null || this.negotiating !== null;
  }

  // ---------------------------------------------------------------- private

  private clearTimer(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  private operation(options: SubscriptionOptions) {
    return {
      query: options.query,
      ...(options.variables !== undefined ? { variables: options.variables } : {}),
      ...(options.operationName ? { operationName: options.operationName } : {}),
    };
  }

  private connectionParams(): { connectionParams?: Record<string, unknown> } {
    return Object.keys(this.initParams).length > 0 ? { connectionParams: this.initParams } : {};
  }

  /**
   * Adapts the protocol-neutral sink onto SubscriptionMessage + the caller's
   * callbacks. Terminal events are reported once and tear the run down (so a
   * failed graphql-ws client stops retrying in the background).
   */
  private createSink(options: SubscriptionOptions): SubscriptionSink {
    const gen = this.generation;
    let settled = false;
    const live = (): boolean => !settled && gen === this.generation;
    const terminate = (): void => {
      settled = true;
      queueMicrotask(() => {
        if (gen === this.generation) this.disconnect();
      });
    };
    return {
      connected: (protocol) => {
        if (!live()) return;
        this.clearTimer();
        options.onMessage({ id: makeId(), type: 'connected', protocol, timestamp: Date.now() });
        options.onConnected?.();
      },
      next: (value) => {
        if (!live()) return;
        options.onMessage({ id: makeId(), type: 'data', payload: value, timestamp: Date.now() });
      },
      error: (err) => {
        if (!live()) return;
        terminate();
        this.clearTimer();
        options.onMessage({
          id: makeId(),
          type: 'error',
          error: describeSubscriptionError(err, 'Subscription error'),
          timestamp: Date.now(),
        });
        options.onError?.(err);
      },
      complete: () => {
        if (!live()) return;
        terminate();
        this.clearTimer();
        options.onMessage({ id: makeId(), type: 'complete', timestamp: Date.now() });
        options.onComplete?.();
      },
    };
  }

  /**
   * `auto`: open one socket offering both subprotocols and hand it to the client
   * for whichever the server selected — no second handshake.
   *
   * Legacy `subscriptions-transport-ws` servers on a default `ws` server accept
   * the FIRST offered subprotocol (`graphql-transport-ws`) and then close with
   * 1002 because it isn't theirs. When the adopted socket closes like that
   * before any frame arrives, fall back once to a legacy-only socket.
   */
  private negotiate(options: SubscriptionOptions, sink: SubscriptionSink): void {
    const wsUrl = toWebSocketUrl(options.url);
    const socket = openSubscriptionSocket(wsUrl, AUTO_SUBPROTOCOLS, this.headers, this.mainSide);
    this.negotiating = socket;
    const abandon = (err: unknown): void => {
      if (this.negotiating !== socket) return;
      this.negotiating = null;
      socket.onopen = null;
      socket.onerror = null;
      socket.onclose = null;
      sink.error(err);
    };
    socket.onerror = (ev) => abandon(new Error(describeSubscriptionError(ev, 'Connection error')));
    socket.onclose = (ev) =>
      abandon(new Error(`Connection closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`));
    socket.onopen = () => {
      if (this.negotiating !== socket) return;
      this.negotiating = null;
      socket.onopen = null;
      socket.onerror = null;
      // Buffer a close that lands before the graphql-ws client adopts the socket.
      let earlyClose: { code: number; reason: string } | null = null;
      socket.onclose = (ev) => {
        earlyClose = ev;
      };
      if (socket.protocol === LEGACY_GRAPHQL_WS_SUBPROTOCOL) {
        this.unsubscribe = runLegacyWsSubscription(
          socket,
          { ...this.operation(options), ...this.connectionParams() },
          sink
        );
        return;
      }
      const gen = this.generation;
      let fellBack = false;
      const guarded: SubscriptionSink = {
        connected: (p) => {
          if (!fellBack) sink.connected(p);
        },
        next: (v) => {
          if (!fellBack) sink.next(v);
        },
        error: (e) => {
          if (!fellBack) sink.error(e);
        },
        complete: () => {
          if (!fellBack) sink.complete();
        },
      };
      const fallBackToLegacy = (): void => {
        if (fellBack || gen !== this.generation) return;
        fellBack = true;
        const client = this.client;
        this.client = null;
        this.unsubscribe = null;
        client?.dispose();
        try {
          this.unsubscribe = runLegacyWsSubscription(
            openSubscriptionSocket(
              wsUrl,
              [LEGACY_GRAPHQL_WS_SUBPROTOCOL],
              this.headers,
              this.mainSide
            ),
            { ...this.operation(options), ...this.connectionParams() },
            sink
          );
        } catch (err) {
          sink.error(err);
        }
      };
      this.runTransportWs(options, guarded, {
        socket,
        takeEarlyClose: () => earlyClose,
        onProtocolRejected: fallBackToLegacy,
      });
    };
  }

  /** graphql-transport-ws via the graphql-ws SDK, optionally adopting an already-open socket. */
  private runTransportWs(
    options: SubscriptionOptions,
    sink: SubscriptionSink,
    adopted?: AdoptedSocket
  ): void {
    const wsUrl = toWebSocketUrl(options.url);
    assertWebSocketUrl(wsUrl);
    assertBrowserSocketTargetAllowed(wsUrl);
    // Desktop: a renderer-direct WebSocket is CSP-blocked, so tunnel graphql-ws
    // over the WebSocket IPC bridge. Web keeps the native WebSocket.
    const webSocketImpl = adopted
      ? createAdoptingSocketClass(adopted, this.headers, this.mainSide)
      : isElectron()
        ? createElectronGraphQLSocketClass(this.headers, this.mainSide)
        : undefined;

    this.client = createClient({
      url: wsUrl,
      connectionParams: Object.keys(this.initParams).length > 0 ? this.initParams : undefined,
      ...(webSocketImpl ? { webSocketImpl } : {}),
      on: {
        connected: (socket) => {
          const negotiated = (socket as { protocol?: string } | undefined)?.protocol;
          sink.connected(negotiated || GRAPHQL_TRANSPORT_WS_SUBPROTOCOL);
        },
        // A transport error is terminal for the request builder: report it now
        // rather than after graphql-ws exhausts its silent retries.
        error: (err) => sink.error(err),
      },
    });

    const wsSink: Sink = {
      next: (value) => sink.next(value),
      error: (err) => sink.error(err),
      complete: () => sink.complete(),
    };

    this.unsubscribe = this.client.subscribe(this.operation(options), wsSink);
  }
}

/** Close codes meaning "the server doesn't actually speak graphql-transport-ws". */
const PROTOCOL_REJECTED_CLOSE_CODES = new Set([1002, 4406]);

interface AdoptedSocket {
  socket: SubscriptionSocket;
  /** A close that arrived between negotiation and adoption, if any. */
  takeEarlyClose: () => { code: number; reason: string } | null;
  /** Called (instead of surfacing the close) when the server rejects the protocol pre-frame. */
  onProtocolRejected: () => void;
}

/**
 * A WebSocket class for graphql-ws's `webSocketImpl` whose FIRST instance adopts
 * the socket `auto` already negotiated on (firing `onopen` once graphql-ws has
 * attached its handlers); retries open fresh graphql-transport-ws sockets.
 */
function createAdoptingSocketClass(
  adopted: AdoptedSocket,
  headers: Record<string, string>,
  mainSide?: MainSideHandshakeAuth
) {
  let pending: SubscriptionSocket | null = adopted.socket;
  return class AdoptingSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onclose: ((ev: { code: number; reason: string }) => void) | null = null;

    private readonly inner: SubscriptionSocket;

    constructor(url: string) {
      const reuse = pending;
      pending = null;
      this.inner =
        reuse ?? openSubscriptionSocket(url, [GRAPHQL_TRANSPORT_WS_SUBPROTOCOL], headers, mainSide);
      let sawFrame = false;
      const handleClose = (ev: { code: number; reason: string }): void => {
        if (reuse && !sawFrame && PROTOCOL_REJECTED_CLOSE_CODES.has(ev.code)) {
          adopted.onProtocolRejected();
          return;
        }
        this.onclose?.(ev);
      };
      this.inner.onopen = (ev) => this.onopen?.(ev);
      this.inner.onmessage = (ev) => {
        sawFrame = true;
        this.onmessage?.(ev);
      };
      this.inner.onerror = (ev) => this.onerror?.(ev);
      this.inner.onclose = handleClose;
      if (!reuse) return;
      const early = adopted.takeEarlyClose();
      if (early) {
        queueMicrotask(() => handleClose(early));
      } else if (reuse.readyState === SOCKET_OPEN) {
        queueMicrotask(() => this.onopen?.({ type: 'open' }));
      }
    }

    get protocol(): string {
      return this.inner.protocol;
    }

    get readyState(): number {
      return this.inner.readyState;
    }

    send(data: string): void {
      this.inner.send(data);
    }

    close(code?: number, reason?: string): void {
      this.inner.close(code, reason);
    }
  };
}
