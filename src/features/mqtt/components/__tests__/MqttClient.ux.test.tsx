import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMqttStore } from '@/features/mqtt/store/useMqttStore';
import { useRequestStore } from '@/store/useRequestStore';
import MqttClient from '../MqttClient';

const hoisted = vi.hoisted(() => ({
  connect: vi.fn(async (_c: { id: string }) => undefined as unknown),
  disconnect: vi.fn(async (_id: string) => undefined),
  publishWithVariables: vi.fn(async () => undefined),
}));

vi.mock('@/components/ui/select', async () => {
  const mod = await import('./selectMock');
  return mod.nativeSelectModule;
});

vi.mock('@/lib/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/platform')>();
  return { ...actual, isElectron: () => true, getElectronAPI: () => ({}) };
});

vi.mock('@/features/mqtt/lib/mqttManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/mqtt/lib/mqttManager')>();
  return {
    ...actual,
    mqttManager: {
      connect: hoisted.connect,
      disconnect: hoisted.disconnect,
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      cancelRequest: vi.fn(),
    },
  };
});

vi.mock('@/features/mqtt/lib/publishWithVariables', () => ({
  publishWithVariables: hoisted.publishWithVariables,
}));

function seed(status: 'connected' | 'disconnected' = 'connected') {
  const id = useMqttStore.getState().ensureConnectionForTab('tab-1');
  useMqttStore.getState().updateConnection(id, { status });
  return id;
}

const received = (payload: string, topic = 't/1') => ({
  direction: 'received' as const,
  topic,
  payload,
  qos: 0 as const,
  retain: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  useMqttStore.setState({
    connections: {},
    connectionByTabId: {},
    messageFilter: 'all',
    searchQuery: '',
  });
  useRequestStore.setState({ activeTabId: 'tab-1' });
});

describe('MqttClient UX', () => {
  it('shows the connect error inline until the next attempt (S3)', async () => {
    const id = seed('disconnected');
    hoisted.connect.mockImplementationOnce(async () => {
      useMqttStore.getState().addMessage(id, {
        direction: 'system',
        topic: '',
        payload: 'ECONNREFUSED 127.0.0.1:1883',
        qos: 0,
        retain: false,
        error: 'ECONNREFUSED 127.0.0.1:1883',
      });
    });
    render(<MqttClient />);
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('ECONNREFUSED 127.0.0.1:1883');
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('confirms and disconnects before deleting the connection (S4)', async () => {
    const id = seed('connected');
    render(<MqttClient />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete connection' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(useMqttStore.getState().connections[id]).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(useMqttStore.getState().connections[id]).toBeUndefined());
    expect(hoisted.disconnect).toHaveBeenCalledWith(id);
  });

  it('uses the shared freeze toggle: filters still apply and new arrivals are counted (S7)', () => {
    const id = seed();
    act(() => {
      useMqttStore.getState().addMessage(id, received('one'));
    });
    render(<MqttClient />);
    fireEvent.click(screen.getByRole('button', { name: 'Freeze message view' }));
    act(() => {
      useMqttStore.getState().addMessage(id, received('two'));
    });
    expect(screen.queryByText('two')).toBeNull();
    expect(screen.getByText('1 new')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search messages' }), {
      target: { value: 'nomatch' },
    });
    expect(screen.queryByText('one')).toBeNull();
    expect(screen.getByText('No messages match the current filter.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume live messages' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search messages' }), {
      target: { value: '' },
    });
    expect(screen.getByText('two')).toBeTruthy();
  });

  it('tells the user when the 1,000 cap dropped older messages (S8)', () => {
    const id = seed();
    act(() => {
      useMqttStore.getState().addMessages(
        id,
        Array.from({ length: 1002 }, (_, i) => received(String(i)))
      );
    });
    render(<MqttClient />);
    expect(screen.getByText('Showing last 1,000 — 2 older dropped')).toBeTruthy();
  });

  it('labels log controls for assistive tech (S9)', () => {
    const id = seed();
    act(() => {
      useMqttStore.getState().addMessage(id, received('one'));
    });
    render(<MqttClient />);
    expect(screen.getByRole('log', { name: 'MQTT messages' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Filter messages' })).toBeTruthy();
    expect(screen.getByRole('status', { name: /MQTT connection status: Connected/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear messages' }));
    expect(useMqttStore.getState().connections[id]?.messages).toEqual([]);
  });

  it('associates publish labels and publishes with Ctrl+Enter (S9, S10)', async () => {
    seed();
    render(<MqttClient />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Publish/ }));
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'a/b' } });
    const payload = screen.getByLabelText('Payload');
    fireEvent.change(payload, { target: { value: 'hi' } });
    fireEvent.keyDown(payload, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(hoisted.publishWithVariables).toHaveBeenCalledOnce());
  });
});
