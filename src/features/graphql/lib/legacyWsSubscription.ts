import {
  LEGACY_GRAPHQL_WS_SUBPROTOCOL,
  operationPayload,
  SOCKET_OPEN,
  type SubscriptionOperation,
  type SubscriptionSink,
  type SubscriptionSocket,
} from './subscriptionSocket';

/**
 * Minimal client for Apollo's legacy `subscriptions-transport-ws` protocol
 * (WebSocket subprotocol `graphql-ws`):
 * https://github.com/apollographql/subscriptions-transport-ws/blob/master/PROTOCOL.md
 *
 *   client → connection_init { payload }    server → connection_ack | connection_error
 *   client → start { id, payload }          server → data | error | complete (per id)
 *   client → stop { id }                    server → ka (keep-alive, ignored)
 *   client → connection_terminate
 *
 * One operation per socket — the request builder runs a single subscription.
 * Accepts a socket that is still CONNECTING or already OPEN (the `auto` mode
 * hands over the socket it negotiated on). Returns a dispose function that
 * stops the operation and closes the socket.
 */

const OPERATION_ID = '1';

interface LegacyMessage {
  type?: unknown;
  id?: unknown;
  payload?: unknown;
}

export interface LegacyWsSubscriptionOptions extends SubscriptionOperation {
  connectionParams?: Record<string, unknown>;
}

export function runLegacyWsSubscription(
  socket: SubscriptionSocket,
  options: LegacyWsSubscriptionOptions,
  sink: SubscriptionSink
): () => void {
  let done = false;
  let started = false;

  const finish = (): void => {
    done = true;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
  };
  const closeSocket = (code = 1000, reason = ''): void => {
    try {
      socket.close(code, reason);
    } catch {
      /* already closing */
    }
  };
  const send = (msg: Record<string, unknown>): void => socket.send(JSON.stringify(msg));
  const fail = (err: unknown): void => {
    if (done) return;
    finish();
    closeSocket(1000, 'Subscription error');
    sink.error(err);
  };

  const init = (): void => {
    send({ type: 'connection_init', payload: options.connectionParams ?? {} });
  };

  socket.onopen = () => init();
  socket.onerror = (ev) => fail(ev instanceof Error ? ev : new Error(errorMessage(ev)));
  socket.onclose = (ev) => {
    if (done) return;
    finish();
    sink.error(new Error(`Connection closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`));
  };
  socket.onmessage = ({ data }) => {
    if (done) return;
    let msg: LegacyMessage;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data)) as LegacyMessage;
    } catch {
      fail(new Error('Received a non-JSON message'));
      return;
    }
    switch (msg.type) {
      case 'connection_ack':
        if (started) return;
        started = true;
        sink.connected(LEGACY_GRAPHQL_WS_SUBPROTOCOL);
        send({ id: OPERATION_ID, type: 'start', payload: operationPayload(options) });
        return;
      case 'connection_error':
        fail(new Error(errorMessage(msg.payload, 'Connection rejected by server')));
        return;
      case 'ka':
        return;
      case 'data':
        if (msg.id === OPERATION_ID) sink.next(msg.payload);
        return;
      case 'error':
        if (msg.id !== OPERATION_ID) return;
        fail(msg.payload);
        return;
      case 'complete':
        if (msg.id !== OPERATION_ID) return;
        finish();
        try {
          send({ type: 'connection_terminate' });
        } catch {
          /* socket gone */
        }
        closeSocket();
        sink.complete();
        return;
      default:
        return;
    }
  };

  if (socket.readyState === SOCKET_OPEN) init();

  return () => {
    if (done) return;
    finish();
    if (socket.readyState === SOCKET_OPEN) {
      try {
        if (started) send({ id: OPERATION_ID, type: 'stop' });
        send({ type: 'connection_terminate' });
      } catch {
        /* socket gone */
      }
    }
    closeSocket();
  };
}

function errorMessage(value: unknown, fallback = 'WebSocket error'): string {
  if (value && typeof value === 'object') {
    const m = (value as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  if (typeof value === 'string' && value) return value;
  return fallback;
}
