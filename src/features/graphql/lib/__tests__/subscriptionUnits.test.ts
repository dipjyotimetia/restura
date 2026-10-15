import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLegacyWsSubscription } from '../legacyWsSubscription';
import { GraphQLSubscriptionClient, type SubscriptionMessage } from '../subscriptionClient';
import {
  describeSubscriptionError,
  operationPayload,
  type SubscriptionSink,
  type SubscriptionSocket,
  toHttpUrl,
  toWebSocketUrl,
} from '../subscriptionSocket';

/** Scriptable in-memory socket for driving the protocol state machines. */
class FakeSocket implements SubscriptionSocket {
  static instances: FakeSocket[] = [];
  protocol = '';
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  closed: Array<{ code?: number; reason?: string }> = [];
  onopen: SubscriptionSocket['onopen'] = null;
  onmessage: SubscriptionSocket['onmessage'] = null;
  onerror: SubscriptionSocket['onerror'] = null;
  onclose: SubscriptionSocket['onclose'] = null;
  constructor(
    readonly url = '',
    readonly protocols: string | string[] = []
  ) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closed.push({ code, reason });
  }
  open(protocol = ''): void {
    this.protocol = protocol;
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg: unknown): void {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
}

function recordingSink() {
  const events: Array<[string, unknown?]> = [];
  const sink: SubscriptionSink = {
    connected: (p) => events.push(['connected', p]),
    next: (v) => events.push(['next', v]),
    error: (e) => events.push(['error', describeSubscriptionError(e, '?')]),
    complete: () => events.push(['complete']),
  };
  return { events, sink };
}

afterEach(() => {
  FakeSocket.instances = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('subscriptionSocket helpers', () => {
  it('converts URL schemes both ways', () => {
    expect(toWebSocketUrl('https://a/g')).toBe('wss://a/g');
    expect(toWebSocketUrl('http://a/g')).toBe('ws://a/g');
    expect(toWebSocketUrl('ws://a/g')).toBe('ws://a/g');
    expect(toHttpUrl('wss://a/g')).toBe('https://a/g');
    expect(toHttpUrl('ws://a/g')).toBe('http://a/g');
    expect(toHttpUrl('https://a/g')).toBe('https://a/g');
  });

  it('omits absent optional fields from the operation payload', () => {
    expect(operationPayload({ query: 'q' })).toEqual({ query: 'q' });
    expect(operationPayload({ query: 'q', operationName: '' })).toEqual({ query: 'q' });
    expect(operationPayload({ query: 'q', variables: {}, operationName: 'Op' })).toEqual({
      query: 'q',
      variables: {},
      operationName: 'Op',
    });
  });

  it.each([
    [new Error('boom'), 'boom'],
    [[{ message: 'a' }, new Error('b')], 'a, b'],
    [[], 'fallback'],
    [{ message: 'm' }, 'm'],
    [{ reason: 'r' }, 'r'],
    [{ code: 4400 }, 'Connection closed (4400)'],
    ['text', 'text'],
    [null, 'fallback'],
    [{}, 'fallback'],
  ])('describes %j as %s', (input, expected) => {
    expect(describeSubscriptionError(input, 'fallback')).toBe(expected);
  });
});

describe('runLegacyWsSubscription state machine', () => {
  it('runs init → ack → start → data → complete on a CONNECTING socket', () => {
    const socket = new FakeSocket();
    const { events, sink } = recordingSink();
    runLegacyWsSubscription(socket, { query: 'q', connectionParams: { t: 1 } }, sink);
    socket.open('graphql-ws');
    expect(socket.sent[0]).toEqual({ type: 'connection_init', payload: { t: 1 } });
    socket.receive({ type: 'connection_ack' });
    socket.receive({ type: 'connection_ack' }); // duplicate ack is ignored
    expect(socket.sent.filter((m) => m.type === 'start')).toHaveLength(1);
    socket.receive({ type: 'ka' });
    socket.receive({ type: 'data', id: 'other', payload: 1 }); // foreign id ignored
    socket.receive({ type: 'data', id: '1', payload: { data: 1 } });
    socket.receive({ type: 'unknown' });
    socket.receive({ type: 'error', id: 'other', payload: [] });
    socket.receive({ type: 'complete', id: 'other' });
    socket.receive({ type: 'complete', id: '1' });
    expect(events).toEqual([['connected', 'graphql-ws'], ['next', { data: 1 }], ['complete']]);
    expect(socket.sent.at(-1)).toEqual({ type: 'connection_terminate' });
    // Late frames after completion are dropped.
    socket.receive({ type: 'data', id: '1', payload: 2 });
    expect(events).toHaveLength(3);
  });

  it('sends an empty init payload by default', () => {
    const socket = new FakeSocket();
    socket.readyState = 1;
    runLegacyWsSubscription(socket, { query: 'q' }, recordingSink().sink);
    expect(socket.sent[0]).toEqual({ type: 'connection_init', payload: {} });
  });

  it('fails on a non-JSON frame', () => {
    const socket = new FakeSocket();
    const { events, sink } = recordingSink();
    runLegacyWsSubscription(socket, { query: 'q' }, sink);
    socket.open();
    socket.receive('not json');
    expect(events).toEqual([['error', 'Received a non-JSON message']]);
    expect(socket.closed).toHaveLength(1);
  });

  it('uses a generic message for a payload-less connection_error', () => {
    const socket = new FakeSocket();
    const { events, sink } = recordingSink();
    runLegacyWsSubscription(socket, { query: 'q' }, sink);
    socket.open();
    socket.receive({ type: 'connection_error', payload: 'nope' });
    expect(events).toEqual([['error', 'nope']]);
  });

  it('reports a close before completion and a socket error', () => {
    const a = new FakeSocket();
    const ra = recordingSink();
    runLegacyWsSubscription(a, { query: 'q' }, ra.sink);
    a.onclose?.({ code: 1006, reason: 'gone' });
    expect(ra.events).toEqual([['error', 'Connection closed (1006: gone)']]);

    const b = new FakeSocket();
    const rb = recordingSink();
    runLegacyWsSubscription(b, { query: 'q' }, rb.sink);
    b.onerror?.({ message: 'refused' });
    b.onerror?.({ message: 'again' }); // already settled
    expect(rb.events).toEqual([['error', 'refused']]);
  });

  it('dispose before the socket opens just closes it', () => {
    const socket = new FakeSocket();
    const dispose = runLegacyWsSubscription(socket, { query: 'q' }, recordingSink().sink);
    dispose();
    dispose(); // idempotent
    expect(socket.sent).toEqual([]);
    expect(socket.closed).toHaveLength(1);
  });
});

describe('GraphQLSubscriptionClient', () => {
  it('times out a connection that never opens and reports through onError', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    const messages: SubscriptionMessage[] = [];
    const onError = vi.fn();
    const client = new GraphQLSubscriptionClient('ws://x', {});
    client.connect({
      url: 'ws://x',
      query: 'subscription { a }',
      protocol: 'subscriptions-transport-ws',
      onMessage: (m) => messages.push(m),
      onError,
    });
    expect(FakeSocket.instances[0]?.protocols).toEqual(['graphql-ws']);
    vi.advanceTimersByTime(30_000);
    expect(messages.map((m) => [m.type, m.error])).toEqual([
      ['connecting', undefined],
      ['error', 'Connection timeout'],
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('falls back to graphql-transport-ws when the server picks no subprotocol', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const client = new GraphQLSubscriptionClient('ws://x', { Authorization: 'Bearer t' });
    const messages: SubscriptionMessage[] = [];
    client.connect({
      url: 'ws://x',
      query: 'subscription { a }',
      onMessage: (m) => messages.push(m),
    });
    const socket = FakeSocket.instances[0]!;
    expect(socket.protocols).toEqual(['graphql-transport-ws', 'graphql-ws']);
    socket.open('');
    await vi.waitFor(() => expect(socket.sent[0]?.type).toBe('connection_init'));
    expect(socket.sent[0]?.payload).toEqual({ Authorization: 'Bearer t' });
    socket.receive({ type: 'connection_ack' });
    await vi.waitFor(() =>
      expect(messages.find((m) => m.type === 'connected')?.protocol).toBe('graphql-transport-ws')
    );
    client.disconnect();
  });
});
