import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import type { MqttConnection, MqttMessage } from '@/features/mqtt/store/useMqttStore';
import { MqttMessagesPanel } from '../MqttMessagesPanel';

vi.mock('@/components/ui/select', async () => {
  const mod = await import('./selectMock');
  return mod.nativeSelectModule;
});

function msg(over: Partial<MqttMessage> = {}): MqttMessage {
  return {
    id: 'm1',
    direction: 'received',
    topic: 'a/b',
    qos: 0,
    retain: false,
    payload: 'hello',
    timestamp: 1_700_000_000_000,
    ...over,
  };
}

function conn(messages: MqttMessage[] = [], over: Partial<MqttConnection> = {}): MqttConnection {
  return {
    id: 'c1',
    name: 'Broker',
    brokerUrl: 'mqtt://x',
    protocolVersion: 5,
    clientId: '',
    keepalive: 60,
    cleanStart: true,
    connectTimeout: 1000,
    autoReconnect: false,
    status: 'connected',
    subscriptions: [],
    messages,
    templates: [],
    createdAt: 0,
    ...over,
  };
}

function setup(
  over: {
    messages?: MqttMessage[];
    visible?: MqttMessage[];
    selected?: MqttMessage | null;
    paused?: boolean;
    rapid?: boolean;
    connection?: MqttConnection;
  } = {}
) {
  const messages = over.messages ?? [];
  const handlers = {
    onClearMessages: vi.fn(),
    onMessageFilterChange: vi.fn(),
    onSearchQueryChange: vi.fn(),
    onSelectMessage: vi.fn(),
  };
  render(
    <Tabs defaultValue="messages">
      <MqttMessagesPanel
        connection={over.connection ?? conn(messages)}
        messageFilter="all"
        msgPerSec={1.5}
        paused={over.paused ?? false}
        rapidStream={over.rapid ?? false}
        searchQuery=""
        selectedMessage={over.selected ?? null}
        selectedMessageId={over.selected?.id ?? null}
        filteredMessages={messages}
        visibleMessages={over.visible ?? messages}
        {...handlers}
      />
    </Tabs>
  );
  return handlers;
}

describe('MqttMessagesPanel list', () => {
  it('shows placeholders when empty and no subscriptions / client id', () => {
    setup();
    expect(screen.getByText('No messages yet.')).toBeTruthy();
    expect(screen.getByText('Select a message to inspect.')).toBeTruthy();
    expect(screen.getByText('1.5')).toBeTruthy();
    expect(screen.getByText('60s')).toBeTruthy();
    expect(screen.queryByText('Paused')).toBeNull();
  });

  it('renders rows for text, retained, binary and error messages', () => {
    const handlers = setup({
      messages: [
        msg({ id: '1', retain: true, qos: 1 }),
        msg({ id: '2', topic: '', payload: 'AQID', payloadEncoding: 'base64', qos: 2 }),
        msg({ id: '3', direction: 'system', topic: '', error: 'boom', payload: 'x' }),
      ],
      connection: conn([msg()], {
        clientId: 'cli',
        subscriptions: [
          {
            topicFilter: 'a',
            requestedQos: 0,
            status: 'subscribed',
          },
        ],
      }),
      paused: true,
      rapid: true,
    });
    expect(screen.getByText('R')).toBeTruthy();
    expect(screen.getByText('[binary]')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
    expect(screen.getByText('Paused')).toBeTruthy();
    expect(screen.getByText('cli')).toBeTruthy();
    expect(screen.queryByText('No messages yet.')).toBeNull();

    fireEvent.click(screen.getByText('hello'));
    expect(handlers.onSelectMessage).toHaveBeenCalledWith('1');
    const rows = screen.getAllByRole('button').filter((el) => el.tagName === 'LI');
    fireEvent.keyDown(rows[1] as HTMLElement, { key: 'Enter' });
    fireEvent.keyDown(rows[2] as HTMLElement, { key: ' ' });
    fireEvent.keyDown(rows[2] as HTMLElement, { key: 'a' });
    expect(handlers.onSelectMessage.mock.calls.map((c) => c[0])).toEqual(['1', '2', '3']);
  });

  it('forwards filter, search and clear actions', () => {
    const handlers = setup({ messages: [msg()] });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'sent' } });
    expect(handlers.onMessageFilterChange).toHaveBeenCalledWith('sent');
    fireEvent.change(screen.getByPlaceholderText('Search topic, payload'), {
      target: { value: 'q' },
    });
    expect(handlers.onSearchQueryChange).toHaveBeenCalledWith('q');
    fireEvent.click(screen.getByTitle('Clear messages'));
    expect(handlers.onClearMessages).toHaveBeenCalledOnce();
  });
});

describe('MqttMessagesPanel detail', () => {
  it('shows a retained JSON message with all MQTT 5 metadata', () => {
    setup({
      messages: [],
      selected: msg({
        retain: true,
        payload: '{"a":1}',
        responseTopic: 'resp/t',
        correlationData: 'corr-1',
        contentType: 'application/json',
        payloadFormatIndicator: true,
        latencyMs: 12,
        subscriptionIdentifier: [1, 2],
        userProperties: { k: 'v', multi: ['x', 'y'] },
        error: 'late error',
      }),
    });
    expect(screen.getByText('retained')).toBeTruthy();
    expect(screen.getByText('MQTT 5 metadata')).toBeTruthy();
    expect(screen.getByText('resp/t')).toBeTruthy();
    expect(screen.getByText('corr-1')).toBeTruthy();
    expect(screen.getByText('application/json')).toBeTruthy();
    expect(screen.getByText('UTF-8 (indicator 1)')).toBeTruthy();
    expect(screen.getByText('12 ms')).toBeTruthy();
    expect(screen.getByText('1, 2')).toBeTruthy();
    expect(screen.getByText('User properties (v5)')).toBeTruthy();
    expect(screen.getByText('x, y')).toBeTruthy();
    expect(screen.getByText('late error')).toBeTruthy();
    expect(document.body.textContent).toContain('"a": 1');
  });

  it('covers scalar subscription id, bytes indicator and base64 correlation data', () => {
    setup({
      selected: msg({
        topic: '',
        payload: 'not json {',
        payloadFormatIndicator: false,
        subscriptionIdentifier: 7,
        correlationData: 'AQID',
        correlationDataEncoding: 'base64',
        userProperties: {},
      }),
    });
    expect(screen.getByText('bytes (indicator 0)')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText(/\(hex\)/)).toBeTruthy();
    expect(screen.queryByText('User properties (v5)')).toBeNull();
    expect(screen.queryByText('Error')).toBeNull();
    expect(screen.getByText('not json {')).toBeTruthy();
  });

  it('omits metadata for a plain message', () => {
    setup({ selected: msg() });
    expect(screen.queryByText('MQTT 5 metadata')).toBeNull();
    expect(screen.queryByText('retained')).toBeNull();
  });

  it('switches a binary payload between hex and base64 views', () => {
    setup({ selected: msg({ payload: 'AQID', payloadEncoding: 'base64' }) });
    expect(screen.getByText(/binary · 3 bytes/)).toBeTruthy();
    expect(document.body.textContent).toContain('01 02 03');
    fireEvent.click(screen.getByRole('button', { name: 'base64' }));
    expect(document.body.textContent).toContain('AQID');
    fireEvent.click(screen.getByRole('button', { name: 'hex' }));
    expect(document.body.textContent).toContain('01 02 03');
  });
});
