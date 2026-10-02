import { describe, expect, it } from 'vitest';
import { kafkaToLogEntries } from '@/features/kafka/lib/kafkaLogExport';
import { mqttToLogEntries } from '@/features/mqtt/lib/mqttLogExport';
import {
  socketioExportName,
  socketioToLogEntries,
} from '@/features/socketio/lib/socketioLogExport';
import { sseExportName, sseToLogEntries } from '@/features/sse/lib/sseLogExport';
import { wsExportName, wsToLogEntries } from '@/features/websocket/lib/wsLogExport';

describe('message-log adapters', () => {
  it('derive export names from the URL host, with a fallback', () => {
    expect(wsExportName('wss://echo.dev/ws')).toBe('echo.dev-websocket');
    expect(wsExportName('{{base}}')).toBe('websocket-messages');
    expect(socketioExportName('http://io.dev')).toBe('io.dev-socketio');
    expect(socketioExportName('')).toBe('socketio-events');
    expect(sseExportName('https://s.dev/sse')).toBe('s.dev-sse');
    expect(sseExportName('nope')).toBe('sse-stream');
  });

  it('map WebSocket and Socket.IO directions', () => {
    expect(
      wsToLogEntries([
        { id: '1', type: 'sent', dataType: 'text', content: 'hi', timestamp: 1 },
        { id: '2', type: 'received', dataType: 'text', content: 'yo', timestamp: 2 },
      ]).map((e) => e.direction)
    ).toEqual(['out', 'in']);
    const [ack] = socketioToLogEntries([
      {
        id: 'a',
        direction: 'ack',
        eventName: 'ping',
        args: [1],
        ackStatus: 'timeout',
        timestamp: 3,
      },
    ]);
    expect(ack).toMatchObject({ direction: 'in', label: 'ping (ack timeout)', body: '[1]' });
  });

  it('map SSE events and system messages', () => {
    expect(
      sseToLogEntries([
        { id: 'e', kind: 'event', event: 'message', data: 'x', timestamp: 1 },
        { id: 's', kind: 'system', message: 'opened', timestamp: 2 },
      ])
    ).toEqual([
      { id: 'e', timestamp: 1, direction: 'in', label: 'message', body: 'x' },
      { id: 's', timestamp: 2, direction: 'system', body: 'opened' },
    ]);
  });

  it('map MQTT and Kafka records, surfacing errors', () => {
    const [mqtt, mqttErr] = mqttToLogEntries([
      {
        id: 'm',
        direction: 'received',
        topic: 't/1',
        qos: 0,
        retain: false,
        payload: 'p',
        timestamp: 1,
      },
      {
        id: 'n',
        direction: 'sent',
        topic: 't/2',
        qos: 1,
        retain: false,
        payload: 'p',
        error: 'nope',
        timestamp: 2,
      },
    ]);
    expect(mqtt).toMatchObject({ direction: 'in', label: 't/1', body: 'p' });
    expect(mqttErr).toMatchObject({ direction: 'error', body: 'nope' });
    expect(
      kafkaToLogEntries([
        {
          id: 'k',
          direction: 'received',
          topic: 'orders',
          partition: 2,
          offset: '7',
          value: 'v',
          timestamp: 1,
        },
        { id: 'l', direction: 'sent', topic: 'orders', value: 'w', timestamp: 2 },
      ]).map((e) => e.label)
    ).toEqual(['orders[2]@7', 'orders']);
  });
});
