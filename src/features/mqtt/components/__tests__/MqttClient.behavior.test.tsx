import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MQTT_SECRET_SENTINEL, useMqttStore } from '@/features/mqtt/store/useMqttStore';
import { useRequestStore } from '@/store/useRequestStore';
import MqttClient from '../MqttClient';

const hoisted = vi.hoisted(() => ({
  isElectron: vi.fn(() => true),
  openFile: vi.fn(),
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  subscribe: vi.fn(async () => undefined),
  unsubscribe: vi.fn(async () => undefined),
  cancelRequest: vi.fn(async () => undefined),
  publishWithVariables: vi.fn(async () => undefined),
  putBrokerSecret: vi.fn(async () => undefined),
  removeBrokerSecret: vi.fn(async () => undefined),
}));

vi.mock('@/components/ui/select', async () => {
  const mod = await import('./selectMock');
  return mod.nativeSelectModule;
});

vi.mock('@/lib/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/platform')>();
  return {
    ...actual,
    isElectron: hoisted.isElectron,
    getElectronAPI: () => ({ dialog: { openFile: hoisted.openFile } }),
  };
});

vi.mock('@/features/mqtt/lib/mqttManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/mqtt/lib/mqttManager')>();
  return {
    ...actual,
    mqttManager: {
      connect: hoisted.connect,
      disconnect: hoisted.disconnect,
      subscribe: hoisted.subscribe,
      unsubscribe: hoisted.unsubscribe,
      cancelRequest: hoisted.cancelRequest,
    },
  };
});

vi.mock('@/features/mqtt/lib/publishWithVariables', () => ({
  publishWithVariables: hoisted.publishWithVariables,
}));

vi.mock('@/lib/shared/broker-secrets', () => ({
  putBrokerSecret: hoisted.putBrokerSecret,
  removeBrokerSecret: hoisted.removeBrokerSecret,
}));

const change = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const openTab = (name: RegExp) => fireEvent.mouseDown(screen.getByRole('tab', { name }));

function seed(patch: Parameters<ReturnType<typeof useMqttStore.getState>['updateConnection']>[1]) {
  const id = useMqttStore.getState().ensureConnectionForTab('tab-1');
  useMqttStore.getState().updateConnection(id, patch);
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.isElectron.mockReturnValue(true);
  useMqttStore.setState({
    connections: {},
    connectionByTabId: {},
    messageFilter: 'all',
    searchQuery: '',
  });
  useRequestStore.setState({ activeTabId: 'tab-1' });
});

describe('MqttClient shell', () => {
  it('shows the desktop-only panel in the browser', () => {
    hoisted.isElectron.mockReturnValue(false);
    render(<MqttClient />);
    expect(screen.getByText('MQTT is a desktop-only feature')).toBeTruthy();
  });

  it('shows an empty state without an active tab', () => {
    useRequestStore.setState({ activeTabId: null });
    render(<MqttClient />);
    expect(screen.getByText(/No connection/)).toBeTruthy();
    expect((screen.getByTitle('Pause log') as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ['connecting', 'Connecting'],
    ['reconnecting', 'Reconnecting'],
    ['connected', 'Connected'],
  ] as const)('shows the %s status and hides Connect', (status, label) => {
    seed({ brokerUrl: 'mqtt://h', protocolVersion: 4, status });
    render(<MqttClient />);
    expect(screen.getByText('v3.1.1')).toBeTruthy();
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Connect$/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Disconnect/ })).toBeTruthy();
  });

  it('shows the v5 badge and the disconnected state with a Connect button', () => {
    seed({ protocolVersion: 5, status: 'disconnected' });
    render(<MqttClient />);
    expect(screen.getByText('v5.0')).toBeTruthy();
    expect(screen.getByText('Disconnected')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Connect/ })).toBeTruthy();
  });

  it('pauses and resumes the log, disconnects and deletes the connection', async () => {
    const id = seed({ status: 'connected' });
    render(<MqttClient />);
    fireEvent.click(screen.getByTitle('Pause log'));
    expect(screen.getByText('Resume')).toBeTruthy();
    expect(screen.getByText('Paused')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Resume log'));
    expect(screen.getByText('Pause')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Disconnect/ }));
    await waitFor(() => expect(hoisted.disconnect).toHaveBeenCalledWith(id));

    fireEvent.click(screen.getByTitle('Delete connection'));
    await waitFor(() => expect(useMqttStore.getState().connections[id]).toBeUndefined());
  });
});

describe('MqttClient messages', () => {
  it('lists, filters-through and selects messages, then clears them', () => {
    const id = seed({ status: 'connected' });
    const { addMessage } = useMqttStore.getState();
    act(() => {
      addMessage(id, {
        direction: 'received',
        topic: 't/1',
        payload: 'one',
        qos: 0,
        retain: false,
      });
      addMessage(id, { direction: 'sent', topic: 't/2', payload: 'two', qos: 1, retain: true });
    });
    render(<MqttClient />);
    expect(screen.getByText('Messages (2)')).toBeTruthy();
    fireEvent.click(screen.getByText('one'));
    expect(screen.getByText('Message')).toBeTruthy();
    fireEvent.click(screen.getByText('Pause'));
    act(() => {
      addMessage(id, {
        direction: 'received',
        topic: 't/3',
        payload: 'three',
        qos: 0,
        retain: false,
      });
    });
    // paused: the snapshot excludes the new message
    expect(screen.queryByText('three')).toBeNull();
    fireEvent.click(screen.getByText('Resume'));
    expect(screen.getByText('three')).toBeTruthy();

    change(screen.getByPlaceholderText('Search topic, payload'), 'two');
    expect(useMqttStore.getState().searchQuery).toBe('two');
    change(screen.getByRole('combobox'), 'sent');
    expect(useMqttStore.getState().messageFilter).toBe('sent');

    fireEvent.click(screen.getByTitle('Clear messages'));
    expect(useMqttStore.getState().connections[id]?.messages).toEqual([]);
  });
});

describe('MqttClient connect', () => {
  it('connects, storing typed credentials as secret handles first', async () => {
    const id = seed({
      brokerUrl: 'mqtts://broker',
      status: 'disconnected',
      tls: { caPath: '/ca' },
    });
    render(<MqttClient />);
    openTab(/Connection/);
    change(await screen.findByPlaceholderText('Password (optional)'), 'pw');
    change(screen.getByPlaceholderText('Key passphrase (optional)'), 'pp');
    fireEvent.click(screen.getByRole('button', { name: /Connect/ }));
    await waitFor(() => expect(hoisted.connect).toHaveBeenCalledOnce());
    expect(hoisted.putBrokerSecret).toHaveBeenCalledTimes(2);
    const conn = useMqttStore.getState().connections[id];
    expect(conn?.password).toBe(MQTT_SECRET_SENTINEL);
    expect(conn?.tls?.passphrase).toBe(MQTT_SECRET_SENTINEL);
    expect(conn?.tls?.caPath).toBe('/ca');
  });

  it('connects without credentials', async () => {
    seed({ status: 'disconnected' });
    render(<MqttClient />);
    fireEvent.click(screen.getByRole('button', { name: /Connect/ }));
    await waitFor(() => expect(hoisted.connect).toHaveBeenCalledOnce());
    expect(hoisted.putBrokerSecret).not.toHaveBeenCalled();
  });

  it('logs a system error and aborts when secure storage fails', async () => {
    const id = seed({ status: 'disconnected' });
    hoisted.putBrokerSecret.mockRejectedValueOnce(new Error('keychain locked'));
    render(<MqttClient />);
    openTab(/Connection/);
    change(await screen.findByPlaceholderText('Password (optional)'), 'pw');
    fireEvent.click(screen.getByRole('button', { name: /Connect/ }));
    await waitFor(() =>
      expect(useMqttStore.getState().connections[id]?.messages[0]?.error).toContain(
        'keychain locked'
      )
    );
    expect(hoisted.connect).not.toHaveBeenCalled();

    hoisted.putBrokerSecret.mockRejectedValueOnce('plain failure');
    fireEvent.click(screen.getByRole('button', { name: /Connect/ }));
    await waitFor(() =>
      expect(useMqttStore.getState().connections[id]?.messages.length).toBeGreaterThan(0)
    );
  });
});

describe('MqttClient publish', () => {
  it('publishes a 3.1.1 message and hides the Request action', async () => {
    const id = seed({ status: 'connected', protocolVersion: 4 });
    render(<MqttClient />);
    openTab(/Publish/);
    const publish = (await screen.findByRole('button', { name: /^Publish$/ })) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Request/ })).toBeNull();
    change(screen.getByPlaceholderText('restura/test'), 'a/b');
    change(
      screen.getAllByRole('textbox').find((e) => e.tagName === 'TEXTAREA') as HTMLElement,
      'hi'
    );
    const combos = screen.getAllByRole('combobox');
    change(combos[0] as HTMLElement, '2');
    fireEvent.click(screen.getAllByRole('switch')[0] as HTMLElement);
    fireEvent.click(publish);
    await waitFor(() => expect(hoisted.publishWithVariables).toHaveBeenCalledOnce());
    expect(hoisted.publishWithVariables).toHaveBeenCalledWith(
      id,
      { topic: 'a/b', payload: 'hi', qos: 2, retain: true },
      undefined,
      { format: 'text' }
    );
  });

  it('disables publishing while disconnected and swaps payload placeholders per format', async () => {
    seed({ status: 'disconnected' });
    render(<MqttClient />);
    openTab(/Publish/);
    await screen.findByRole('button', { name: /^Publish$/ });
    change(screen.getByPlaceholderText('restura/test'), 'x');
    expect((screen.getByRole('button', { name: /^Publish$/ }) as HTMLButtonElement).disabled).toBe(
      true
    );
    const format = screen.getAllByRole('combobox')[1] as HTMLElement;
    change(format, 'hex');
    expect(screen.getByPlaceholderText('de ad be ef')).toBeTruthy();
    change(format, 'base64');
    expect(screen.getByPlaceholderText('3q2+7w==')).toBeTruthy();
    change(format, 'json');
    expect(screen.queryByPlaceholderText('3q2+7w==')).toBeNull();
  });

  it('publishes with MQTT 5 properties and runs a request / cancel cycle', async () => {
    const id = seed({ status: 'connected', protocolVersion: 5 });
    let release: () => void = () => {};
    hoisted.publishWithVariables.mockImplementationOnce(async () => undefined);
    render(<MqttClient />);
    openTab(/Publish/);
    await screen.findByRole('button', { name: /^Publish$/ });
    change(screen.getByPlaceholderText('restura/test'), 'req/t');
    change(screen.getByPlaceholderText('application/json'), 'text/plain');
    change(screen.getAllByPlaceholderText('auto for Request')[0] as HTMLElement, 'resp/t');
    change(screen.getByDisplayValue('10000'), '2500');
    fireEvent.click(screen.getByRole('button', { name: /^Publish$/ }));
    await waitFor(() => expect(hoisted.publishWithVariables).toHaveBeenCalledOnce());
    expect(hoisted.publishWithVariables.mock.calls[0]).toEqual([
      id,
      expect.objectContaining({ contentType: 'text/plain', responseTopic: 'resp/t' }),
      undefined,
      expect.objectContaining({ format: 'text', topicAlias: undefined }),
    ]);

    hoisted.publishWithVariables.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (release = () => resolve(undefined)))
    );
    fireEvent.click(screen.getByRole('button', { name: /Request/ }));
    const cancel = await screen.findByRole('button', { name: /Cancel request/ });
    const lastCall = hoisted.publishWithVariables.mock.calls.at(-1) as unknown as unknown[];
    const opts = lastCall[3] as { request: { requestId: string; timeoutMs: number } };
    expect(opts.request.timeoutMs).toBe(2500);
    expect('topicAlias' in opts).toBe(false);
    fireEvent.click(cancel);
    await waitFor(() =>
      expect(hoisted.cancelRequest).toHaveBeenCalledWith(id, opts.request.requestId)
    );
    await act(async () => release());
    expect(await screen.findByRole('button', { name: /Request/ })).toBeTruthy();
  });

  it('saves, loads and sends publish templates', async () => {
    const id = seed({ status: 'connected' });
    render(<MqttClient />);
    openTab(/Publish/);
    await screen.findByRole('button', { name: /^Publish$/ });
    fireEvent.click(screen.getByRole('button', { name: /Save current/ }));
    expect(useMqttStore.getState().connections[id]?.templates).toHaveLength(0);

    change(screen.getByPlaceholderText('restura/test'), 'tpl/topic');
    fireEvent.click(screen.getByRole('button', { name: /Save current/ }));
    const templates = useMqttStore.getState().connections[id]?.templates ?? [];
    expect(templates).toHaveLength(1);
    fireEvent.keyDown(screen.getByLabelText('Rename saved publish'), { key: 'Escape' });

    change(screen.getByPlaceholderText('restura/test'), 'other');
    fireEvent.click(screen.getByTitle(/Load into composer/));
    expect((screen.getByPlaceholderText('restura/test') as HTMLInputElement).value).toBe(
      'tpl/topic'
    );
    fireEvent.click(screen.getByLabelText(/^Send /));
    await waitFor(() =>
      expect(hoisted.publishWithVariables).toHaveBeenCalledWith(
        id,
        expect.objectContaining({ topic: 'tpl/topic' })
      )
    );
  });
});

describe('MqttClient subscribe', () => {
  it('subscribes on a 3.1.1 connection without v5 extras and unsubscribes', async () => {
    const id = seed({ status: 'connected', protocolVersion: 4 });
    useMqttStore
      .getState()
      .upsertSubscription(id, { topicFilter: 'old/#', requestedQos: 0, status: 'subscribed' });
    render(<MqttClient />);
    openTab(/Subscribe/);
    change(await screen.findByPlaceholderText(/sensors/), '  s/+  ');
    change(screen.getByRole('combobox'), '1');
    fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }));
    await waitFor(() => expect(hoisted.subscribe).toHaveBeenCalledOnce());
    expect(hoisted.subscribe).toHaveBeenCalledWith({
      connectionId: id,
      topicFilter: 's/+',
      qos: 1,
    });
    fireEvent.click(screen.getByLabelText('Unsubscribe old/#'));
    await waitFor(() => expect(hoisted.unsubscribe).toHaveBeenCalledWith(id, 'old/#'));
  });

  it('passes v5 subscription options and identifier', async () => {
    const id = seed({ status: 'connected', protocolVersion: 5 });
    render(<MqttClient />);
    openTab(/Subscribe/);
    change(await screen.findByPlaceholderText(/sensors/), 'v5/t');
    fireEvent.click(screen.getByLabelText('No Local'));
    change(screen.getByPlaceholderText('optional'), '12');
    fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }));
    await waitFor(() => expect(hoisted.subscribe).toHaveBeenCalledOnce());
    expect(hoisted.subscribe).toHaveBeenCalledWith({
      connectionId: id,
      topicFilter: 'v5/t',
      qos: 0,
      options: { noLocal: true },
      subscriptionIdentifier: 12,
    });
  });

  it('subscribes on v5 with no options set', async () => {
    seed({ status: 'connected', protocolVersion: 5 });
    render(<MqttClient />);
    openTab(/Subscribe/);
    change(await screen.findByPlaceholderText(/sensors/), 'plain');
    fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }));
    await waitFor(() => expect(hoisted.subscribe).toHaveBeenCalledOnce());
    expect(hoisted.subscribe).toHaveBeenCalledWith(
      expect.not.objectContaining({ options: expect.anything() })
    );
  });
});

describe('MqttClient connection settings', () => {
  it('picks TLS files, ignoring a cancelled dialog', async () => {
    const id = seed({ brokerUrl: 'wss://h/mqtt' });
    render(<MqttClient />);
    openTab(/Connection/);
    const browse = await screen.findAllByRole('button', { name: 'Browse' });
    hoisted.openFile.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    fireEvent.click(browse[0] as HTMLElement);
    await waitFor(() => expect(hoisted.openFile).toHaveBeenCalledTimes(1));
    expect(useMqttStore.getState().connections[id]?.tls?.caPath).toBeUndefined();

    hoisted.openFile.mockResolvedValueOnce({ canceled: false, filePaths: ['/c.pem'] });
    fireEvent.click(browse[1] as HTMLElement);
    await waitFor(() =>
      expect(useMqttStore.getState().connections[id]?.tls?.certPath).toBe('/c.pem')
    );
    hoisted.openFile.mockResolvedValueOnce({ canceled: false, filePaths: [] });
    fireEvent.click(browse[2] as HTMLElement);
    await waitFor(() => expect(hoisted.openFile).toHaveBeenCalledTimes(3));
    expect(useMqttStore.getState().connections[id]?.tls?.keyPath).toBeUndefined();
  });

  it('stores and clears enhanced-auth data, reporting failures', async () => {
    const id = seed({ protocolVersion: 5, connectProperties: { authenticationMethod: 'SCRAM' } });
    render(<MqttClient />);
    openTab(/Connection/);
    const input = (await screen.findByPlaceholderText(
      'optional (stored securely)'
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'tok' } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(useMqttStore.getState().connections[id]?.connectProperties?.authenticationData).toBe(
        MQTT_SECRET_SENTINEL
      )
    );
    expect(useMqttStore.getState().connections[id]?.connectProperties?.authenticationMethod).toBe(
      'SCRAM'
    );

    fireEvent.click(await screen.findByText('Clear stored auth data'));
    await waitFor(() => expect(hoisted.removeBrokerSecret).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        useMqttStore.getState().connections[id]?.connectProperties?.authenticationData
      ).toBeUndefined()
    );

    hoisted.putBrokerSecret.mockRejectedValueOnce(new Error('denied'));
    const again = screen.getByPlaceholderText('optional (stored securely)') as HTMLInputElement;
    fireEvent.change(again, { target: { value: 'tok2' } });
    fireEvent.blur(again);
    await waitFor(() =>
      expect(useMqttStore.getState().connections[id]?.messages.at(-1)?.error).toContain('denied')
    );
    hoisted.putBrokerSecret.mockRejectedValueOnce('nope');
    fireEvent.change(again, { target: { value: 'tok3' } });
    fireEvent.blur(again);
    await waitFor(() =>
      expect(useMqttStore.getState().connections[id]?.messages.at(-1)?.error).toContain('nope')
    );
  });

  it('edits the last will through the store', async () => {
    const id = seed({});
    render(<MqttClient />);
    openTab(/Connection/);
    const will = (await screen.findAllByRole('switch')).at(-1) as HTMLElement;
    fireEvent.click(will);
    expect(useMqttStore.getState().connections[id]?.lwt).toBeDefined();
    fireEvent.change(screen.getByPlaceholderText('Will topic'), { target: { value: 'w/t' } });
    expect(useMqttStore.getState().connections[id]?.lwt?.topic).toBe('w/t');
  });
});
