import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMqttStore } from '@/features/mqtt/store/useMqttStore';
import { useRequestStore } from '@/store/useRequestStore';
import MqttClient from '../MqttClient';

// Renders the whole MQTT panel (desktop path) to catch wiring errors in the
// new MQTT 5 / binary / request controls — not just the leaf components.
describe('MqttClient (desktop) smoke', () => {
  beforeEach(() => {
    (window as unknown as { electron: unknown }).electron = {
      isElectron: true,
      mqtt: {
        connect: vi.fn(async () => ({ success: true })),
        publish: vi.fn(async () => ({ success: true })),
        request: vi.fn(async () => ({ success: false, timedOut: true, error: 'timeout' })),
        cancelRequest: vi.fn(async () => ({ success: true })),
        subscribe: vi.fn(async () => ({ success: true })),
        unsubscribe: vi.fn(async () => ({ success: true })),
        disconnect: vi.fn(async () => ({ success: true })),
        on: vi.fn(),
        removeListener: vi.fn(),
        removeAllListeners: vi.fn(),
      },
      store: { get: vi.fn(async () => null), set: vi.fn(), delete: vi.fn() },
      secrets: {
        store: vi.fn(async ({ id }: { id: string }) => ({ ok: true, id })),
        delete: vi.fn(async () => ({ ok: true })),
        describe: vi.fn(async () => ({ ok: true, handle: null })),
        copy: vi.fn(async () => ({ ok: true, copied: false })),
      },
    };
    useRequestStore.setState({ activeTabId: 'tab-1' });
  });
  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('renders every tab with MQTT 5 controls for a v5 wss connection', async () => {
    const id = useMqttStore.getState().ensureConnectionForTab('tab-1');
    useMqttStore.getState().updateConnection(id, {
      brokerUrl: 'wss://broker.example.com/mqtt',
      status: 'connected',
    });
    render(<MqttClient />);

    fireEvent.mouseDown(screen.getByRole('tab', { name: /Publish/ }));
    expect(await screen.findByRole('button', { name: /Request/ })).toBeTruthy();
    expect(screen.getByLabelText('Payload format indicator')).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole('tab', { name: /Subscribe/ }));
    expect(await screen.findByLabelText('No Local')).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole('tab', { name: /Connection/ }));
    expect(await screen.findByText('CONNECT properties (v5)')).toBeTruthy();
    expect(screen.getByText('TLS (mqtts / wss)')).toBeTruthy();
  });
});
