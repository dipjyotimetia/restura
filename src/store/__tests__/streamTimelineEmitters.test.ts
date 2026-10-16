import { beforeEach, describe, expect, it } from 'vitest';
import { useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import { useMqttStore } from '@/features/mqtt/store/useMqttStore';
import { useSocketIOStore } from '@/features/socketio/store/useSocketIOStore';
import { useSseStore } from '@/features/sse/store/useSseStore';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import { useStreamTimelineStore } from '@/store/useStreamTimelineStore';

/** Acceptance: all five streaming protocols emit into the shared timeline. */
describe('streaming stores emit into the unified timeline', () => {
  beforeEach(() => {
    useStreamTimelineStore.getState().clear();
    useStreamTimelineStore.getState().setPaused(false);
  });

  const flushed = () => {
    useStreamTimelineStore.getState().flush();
    return useStreamTimelineStore.getState().events;
  };

  it('WebSocket messages', () => {
    const id = useWebSocketStore.getState().createConnection('wss://example.test');
    useWebSocketStore.getState().addMessage(id, 'sent', 'ping');
    useWebSocketStore.getState().addMessage(id, 'received', 'pong');
    const events = flushed();
    expect(events.map((e) => [e.protocol, e.direction, e.payload])).toEqual([
      ['websocket', 'out', 'ping'],
      ['websocket', 'in', 'pong'],
    ]);
    expect(events[0]!.connectionId).toBe(id);
  });

  it('Socket.IO events including acks', () => {
    const id = useSocketIOStore.getState().createConnection('https://example.test');
    useSocketIOStore.getState().addEvent(id, { direction: 'ack', eventName: '<ack>', args: [1] });
    const [e] = flushed();
    expect(e).toMatchObject({ protocol: 'socketio', kind: 'ack', label: '<ack>', payload: '[1]' });
    expect(e!.meta.namespace).toBe('/');
  });

  it('SSE events and system messages', () => {
    const id = useSseStore.getState().createConnection();
    useSseStore.getState().appendEvent(id, { event: 'tick', data: '1', lastEventId: '7' });
    useSseStore.getState().appendSystem(id, 'Connected');
    const events = flushed();
    expect(events[0]).toMatchObject({ protocol: 'sse', label: 'tick', meta: { lastEventId: '7' } });
    expect(events[1]).toMatchObject({ protocol: 'sse', direction: 'system', kind: 'system' });
  });

  it('Kafka records with partition/offset meta', () => {
    const id = useKafkaStore.getState().createConnection();
    useKafkaStore.getState().addMessage(id, {
      direction: 'received',
      topic: 'orders',
      partition: 2,
      offset: '41',
      value: '{"id":1}',
    });
    // A tombstone can arrive without a value at runtime.
    useKafkaStore.getState().addMessage(id, {
      direction: 'received',
      topic: 'orders',
      value: undefined as unknown as string,
      tombstone: true,
    });
    const [e, tombstone] = flushed();
    expect(tombstone).toMatchObject({ payload: '', meta: { tombstone: true } });
    expect(e).toMatchObject({
      protocol: 'kafka',
      direction: 'in',
      label: 'orders',
      meta: { partition: 2, offset: '41' },
    });
  });

  it('MQTT single and batched messages', () => {
    const id = useMqttStore.getState().createConnection();
    useMqttStore.getState().addMessage(id, {
      direction: 'sent',
      topic: 'a/b',
      qos: 1,
      retain: false,
      payload: 'on',
    });
    useMqttStore.getState().addMessages(id, [
      { direction: 'received', topic: 'a/b', qos: 0, retain: true, payload: 'x' },
      { direction: 'system', topic: '', qos: 0, retain: false, payload: '', error: 'boom' },
    ]);
    const events = flushed();
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ protocol: 'mqtt', direction: 'out', meta: { qos: 1 } });
    expect(events[1]!.meta.retain).toBe(true);
    expect(events[2]!.kind).toBe('error');
  });
});
