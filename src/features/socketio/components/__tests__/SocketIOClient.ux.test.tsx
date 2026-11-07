import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type SocketIOConnection,
  useSocketIOStore,
} from '@/features/socketio/store/useSocketIOStore';
import { useRequestStore } from '@/store/useRequestStore';
import SocketIOClient from '../SocketIOClient';
import { countConfiguredOptions } from '../SocketIOConnectionOptions';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

function seed(patch: Partial<SocketIOConnection>) {
  const id = useSocketIOStore.getState().ensureConnectionForTab('sio-tab');
  useSocketIOStore.setState((s) => ({
    connections: { ...s.connections, [id]: { ...s.connections[id]!, ...patch } },
  }));
  return id;
}

beforeEach(() => {
  useSocketIOStore.setState({ connections: {}, connectionByTabId: {} });
  useRequestStore.setState({ activeTabId: 'sio-tab' });
});

describe('SocketIOClient reconnect visibility (S11)', () => {
  it('shows reconnect progress as n/max', () => {
    seed({ status: 'reconnecting', reconnectAttemptCount: 2, reconnectionAttempts: 5 });
    render(<SocketIOClient />);
    expect(screen.getByText('RECONNECTING (2/5)')).toBeTruthy();
  });

  it('locks the auto-reconnect toggle while connected', () => {
    seed({ status: 'connected' });
    render(<SocketIOClient />);
    expect(screen.getByRole('switch', { name: 'Auto-reconnect' })).toBeDisabled();
  });

  it('hides the Latency stat (no latency is measured)', () => {
    seed({ status: 'connected' });
    render(<SocketIOClient />);
    expect(screen.queryByText('Latency')).toBeNull();
  });

  it('does not count or offer the no-op Force new option', () => {
    const id = seed({ forceNew: true });
    const conn = useSocketIOStore.getState().connections[id]!;
    expect(countConfiguredOptions(conn)).toBe(countConfiguredOptions({ ...conn, forceNew: false }));
    render(<SocketIOClient />);
    expect(screen.queryByRole('switch', { name: 'Force new connection' })).toBeNull();
  });
});
