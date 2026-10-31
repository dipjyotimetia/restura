import { beforeEach, describe, expect, it } from 'vitest';
import { type SseLogEntry, useSseStore } from '@/features/sse/store/useSseStore';

const get = () => useSseStore.getState();

describe('useSseStore branches', () => {
  beforeEach(async () => {
    await useSseStore.persist.rehydrate();
    useSseStore.setState({
      connections: {},
      summaries: {},
      activeConnectionId: null,
      searchQuery: '',
    });
  });

  it('every setter is a no-op for an unknown connection', () => {
    const before = get().connections;
    get().updateConnectionStatus('nope', 'connected');
    get().setReconnectAttempts('nope', 3);
    get().setLastEventId('nope', 'x');
    get().setLastConnectedAt('nope', 1);
    get().appendEvent('nope', { event: 'm', data: 'd' });
    get().appendSystem('nope', 'hello');
    get().clearLog('nope');
    expect(get().connections).toBe(before);
    expect(get().getFilteredLog('nope')).toEqual([]);
  });

  it('updates status, attempts, last event id and last connected time', () => {
    const id = get().createConnection();
    get().updateConnectionStatus(id, 'connected');
    get().setReconnectAttempts(id, 2);
    get().setLastEventId(id, 'abc');
    get().setLastConnectedAt(id, 123);
    expect(get().connections[id]).toMatchObject({
      status: 'connected',
      reconnectAttempts: 2,
      lastEventId: 'abc',
      lastConnectedAt: 123,
    });
  });

  it('records the event id and retry only when present and tracks the last id', () => {
    const id = get().createConnection();
    get().appendEvent(id, { event: 'a', data: 'x' });
    get().appendEvent(id, { event: 'b', data: 'y', lastEventId: '9', retry: 500 });
    const [first, second] = get().connections[id]!.log as Array<SseLogEntry & { kind: 'event' }>;
    expect(first).not.toHaveProperty('lastEventId');
    expect(first).not.toHaveProperty('retry');
    expect(second).toMatchObject({ lastEventId: '9', retry: 500 });
    expect(get().connections[id]?.lastEventId).toBe('9');
  });

  it('omits the console label for an unnamed event', () => {
    const id = get().createConnection();
    expect(() => get().appendEvent(id, { event: '', data: 'x' })).not.toThrow();
  });

  it('creates a missing summary on demand when appending', () => {
    const id = get().createConnection();
    useSseStore.setState({ summaries: {} });
    get().appendEvent(id, { event: 'token', data: 'z' });
    expect(get().summaries[id]).toMatchObject({ eventCount: 1 });
  });

  it('trims the event log to the newest 1000 entries and rebuilds the summary', () => {
    const id = get().createConnection();
    for (let i = 0; i < 1002; i++) get().appendEvent(id, { event: 'message', data: `d${i}` });
    const log = get().connections[id]!.log;
    expect(log).toHaveLength(1000);
    expect((log[0] as { data: string }).data).toBe('d2');
    expect(get().summaries[id]?.eventCount).toBe(1000);
  });

  it('trims system messages to 1000 entries', () => {
    const id = get().createConnection();
    for (let i = 0; i < 1001; i++) get().appendSystem(id, `m${i}`);
    const log = get().connections[id]!.log;
    expect(log).toHaveLength(1000);
    expect((log[0] as { message: string }).message).toBe('m1');
  });

  it('removes a connection and clears the active pointer only when it was active', () => {
    const a = get().createConnection();
    const b = get().createConnection();
    expect(get().activeConnectionId).toBe(b);
    get().removeConnection(a);
    expect(get().activeConnectionId).toBe(b);
    expect(get().summaries[a]).toBeUndefined();
    get().removeConnection(b);
    expect(get().activeConnectionId).toBeNull();
    expect(get().getActiveConnection()).toBeNull();
  });

  it('exposes the active connection', () => {
    const a = get().createConnection();
    get().createConnection();
    get().setActiveConnection(a);
    expect(get().getActiveConnection()?.id).toBe(a);
    get().setActiveConnection('missing');
    expect(get().getActiveConnection()).toBeNull();
  });

  it('filters by event name and search text across events and system messages', () => {
    const id = get().createConnection();
    get().appendSystem(id, 'Connected to server');
    get().appendEvent(id, { event: 'tick', data: 'Hello' });
    get().appendEvent(id, { event: 'Pong', data: 'other' });

    get().setSearchQuery('  ');
    expect(get().getFilteredLog(id)).toHaveLength(3);

    get().setSearchQuery('hello');
    expect(get().getFilteredLog(id)).toHaveLength(1);
    get().setSearchQuery('pong');
    expect(get().getFilteredLog(id)).toHaveLength(1);
    get().setSearchQuery('connected');
    const sys = get().getFilteredLog(id);
    expect(sys).toHaveLength(1);
    expect(sys[0]?.kind).toBe('system');

    get().setSearchQuery('');
    expect(get().getFilteredLog(id, 'tick')).toHaveLength(1);
    get().setSearchQuery('zzz');
    expect(get().getFilteredLog(id, 'tick')).toHaveLength(0);
  });

  it('persists runtime-safe fields only', () => {
    const id = get().createConnection();
    get().appendSystem(id, 'x');
    get().setLastEventId(id, '5');
    get().setLastConnectedAt(id, 9);
    get().updateConnectionStatus(id, 'connected');
    const id2 = get().createConnection();

    const options = useSseStore.persist.getOptions();
    const out = options.partialize?.(get()) as unknown as {
      connections: Record<string, Record<string, unknown>>;
      activeConnectionId: string;
    };
    expect(out.activeConnectionId).toBe(id2);
    expect(out.connections[id]).toMatchObject({
      status: 'disconnected',
      log: [],
      lastEventId: '5',
      lastConnectedAt: 9,
      reconnectAttempts: 0,
    });
    expect(out.connections[id2]).not.toHaveProperty('lastEventId');
    expect(out.connections[id2]).not.toHaveProperty('lastConnectedAt');
  });
});
