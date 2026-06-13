import { getElectronAPI } from '@/lib/shared/platform';

// graphql-ws drives a standard WebSocket. On desktop the renderer can't open one
// directly (packaged CSP blocks ws:/wss:), so this adapter implements the slice
// of the WebSocket interface graphql-ws needs on top of the WebSocket IPC bridge
// (electron/main/websocket-handler.ts). graphql-ws verifies `socket.protocol`
// after open, so we surface the negotiated subprotocol from the ws:open payload.
//
// graphql-ws constructs the impl as `new Impl(url, GRAPHQL_TRANSPORT_WS_PROTOCOL)`,
// so handshake headers (auth) can't ride the constructor — they're closed over by
// the factory and sent as WS handshake headers via the IPC connect call.

type Listener = (...args: unknown[]) => void;
type CloseHandler = (ev: { code: number; reason: string }) => void;
type MessageHandler = (ev: { data: string }) => void;
type OpenErrorHandler = (ev: unknown) => void;

const channel = (kind: string, id: string): string => `ws:${kind}:${id}`;

/**
 * Build a WebSocket-compatible class (for graphql-ws `webSocketImpl`) that tunnels
 * over the Electron WS IPC bridge. `headers` are sent as handshake headers.
 */
export function createElectronGraphQLSocketClass(headers: Record<string, string>): {
  new (url: string, protocol?: string | string[]): ElectronGraphQLSocket;
} {
  return class extends ElectronGraphQLSocket {
    constructor(url: string, protocol?: string | string[]) {
      super(url, protocol, headers);
    }
  };
}

export class ElectronGraphQLSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  protocol = '';
  binaryType = 'arraybuffer';
  readyState: number = ElectronGraphQLSocket.CONNECTING;

  onopen: ((ev: unknown) => void) | null = null;
  onmessage: MessageHandler | null = null;
  onerror: OpenErrorHandler | null = null;
  onclose: CloseHandler | null = null;

  private readonly connectionId: string;
  private readonly listeners = new Map<string, Listener>();

  constructor(
    url: string,
    protocol: string | string[] | undefined,
    headers: Record<string, string>
  ) {
    this.url = url;
    this.connectionId = `gql-sub-${crypto.randomUUID()}`;
    const api = getElectronAPI()?.websocket;
    if (!api) {
      // Surface asynchronously so graphql-ws has attached its handlers first.
      queueMicrotask(() => this.fail('Electron WebSocket API unavailable'));
      return;
    }

    const protocols = Array.isArray(protocol) ? protocol : protocol ? [protocol] : [];

    this.listen(api, channel('open', this.connectionId), (payload) => {
      this.protocol = (payload as { protocol?: string } | undefined)?.protocol ?? '';
      this.readyState = ElectronGraphQLSocket.OPEN;
      this.onopen?.({ type: 'open' });
    });
    this.listen(api, channel('message', this.connectionId), (payload) => {
      const msg = payload as { type: 'text' | 'binary'; data: string } | undefined;
      // graphql-transport-ws is text/JSON; binary frames aren't part of it.
      if (msg?.type === 'text') this.onmessage?.({ data: msg.data });
    });
    this.listen(api, channel('error', this.connectionId), (payload) => {
      const err = payload as { message?: string } | undefined;
      this.onerror?.({ type: 'error', message: err?.message ?? 'WebSocket error' });
    });
    this.listen(api, channel('close', this.connectionId), (payload) => {
      const ev = payload as { code?: number; reason?: string } | undefined;
      this.finishClose(ev?.code ?? 1006, ev?.reason ?? '');
    });

    void api
      .connect({
        connectionId: this.connectionId,
        url,
        headers,
        ...(protocols.length > 0 ? { protocols } : {}),
      })
      .then((res) => {
        if (!res.success) this.fail(res.error ?? 'Connection failed');
      })
      .catch((err: unknown) => this.fail(err instanceof Error ? err.message : 'Connection failed'));
  }

  send(data: string): void {
    getElectronAPI()?.websocket?.send({ connectionId: this.connectionId, message: data });
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === ElectronGraphQLSocket.CLOSED) return;
    this.readyState = ElectronGraphQLSocket.CLOSING;
    void getElectronAPI()?.websocket?.disconnect({ connectionId: this.connectionId });
    // The main process acks an explicit disconnect without a ws:close event, so
    // settle the close locally.
    this.finishClose(code, reason);
  }

  private listen(
    api: NonNullable<ReturnType<typeof getElectronAPI>>['websocket'],
    ch: string,
    cb: Listener
  ): void {
    this.listeners.set(ch, cb);
    api.on(ch, cb);
  }

  private cleanup(): void {
    const api = getElectronAPI()?.websocket;
    for (const ch of this.listeners.keys()) api?.removeAllListeners(ch);
    this.listeners.clear();
  }

  private fail(message: string): void {
    this.onerror?.({ type: 'error', message });
    this.finishClose(1006, message);
  }

  private finishClose(code: number, reason: string): void {
    if (this.readyState === ElectronGraphQLSocket.CLOSED) return;
    this.readyState = ElectronGraphQLSocket.CLOSED;
    this.cleanup();
    this.onclose?.({ code, reason });
  }
}
