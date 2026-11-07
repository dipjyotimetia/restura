import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  type SocketIOConnection,
  type SocketIOEvent,
  useSocketIOStore,
} from '@/features/socketio/store/useSocketIOStore';
import { useRequestStore } from '@/store/useRequestStore';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('@/features/socketio/lib/connectWithVariables', () => ({
  connectWithVariables: vi.fn(),
}));
vi.mock('@/features/socketio/lib/emitWithVariables', () => ({
  emitWithVariables: vi.fn(() => ({ ok: true })),
  replyAckWithVariables: vi.fn(() => ({ ok: true })),
}));
vi.mock('@/features/socketio/lib/socketioManager', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    socketioManager: { disconnect: vi.fn(), emit: vi.fn(), replyServerAck: vi.fn() },
  };
});

import { connectWithVariables } from '@/features/socketio/lib/connectWithVariables';
import {
  emitWithVariables,
  replyAckWithVariables,
} from '@/features/socketio/lib/emitWithVariables';
import { socketioManager } from '@/features/socketio/lib/socketioManager';
import SocketIOClient from '../SocketIOClient';

const TAB = 'sio-int-tab';

function seed(patch: Partial<SocketIOConnection>) {
  const id = useSocketIOStore.getState().ensureConnectionForTab(TAB);
  useSocketIOStore.setState((s) => ({
    connections: { ...s.connections, [id]: { ...s.connections[id]!, ...patch } },
  }));
  return id;
}

function conn(id: string) {
  return useSocketIOStore.getState().connections[id]!;
}

let n = 0;
function ev(patch: Partial<SocketIOEvent>): SocketIOEvent {
  n += 1;
  return {
    id: `e${n}`,
    direction: 'received',
    eventName: 'msg',
    args: [],
    timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
    ...patch,
  };
}

const kv = (key: string, value: string) => ({ id: key, key, value, enabled: true });

beforeEach(() => {
  vi.clearAllMocks();
  useSocketIOStore.setState({
    connections: {},
    connectionByTabId: {},
    eventFilter: 'all',
    searchQuery: '',
  });
  useRequestStore.setState({ activeTabId: TAB });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SocketIOClient — disconnected connection bar', () => {
  it('shows the placeholder when there is no active tab', () => {
    useRequestStore.setState({ activeTabId: null });
    render(<SocketIOClient />);
    expect(screen.getByText('Preparing Socket.IO connection…')).toBeInTheDocument();
  });

  it('disables Connect without a URL and connects directly over https with no prompt', async () => {
    const id = seed({ url: '' });
    const { rerender } = render(<SocketIOClient />);
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(screen.getByTestId('socketio-status')).toHaveTextContent('DISCONNECTED');

    act(() => {
      useSocketIOStore.getState().updateConnectionField(id, 'url', 'https://srv.example.com');
    });
    rerender(<SocketIOClient />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(connectWithVariables).toHaveBeenCalledWith(id));
  });

  it('stores the typed server URL as the unresolved template', () => {
    const id = seed({ url: '' });
    render(<SocketIOClient />);
    fireEvent.change(screen.getByLabelText('Socket.IO server URL'), {
      target: { value: 'https://{{host}}' },
    });
    expect(conn(id).url).toBe('https://{{host}}');
  });

  it('edits the namespace, falling back to "/" when cleared', () => {
    const id = seed({ url: 'https://srv' });
    render(<SocketIOClient />);
    const ns = screen.getByRole('textbox', { name: 'Namespace' });
    fireEvent.change(ns, { target: { value: '/chat' } });
    expect(conn(id).namespace).toBe('/chat');
    fireEvent.change(ns, { target: { value: '' } });
    expect(conn(id).namespace).toBe('/');
  });

  it('asks before sending kv auth over cleartext http, and aborts on cancel', async () => {
    seed({ url: 'http://insecure.local', auth: [kv('token', 'abc')] });
    render(<SocketIOClient />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(
      await screen.findByText('Send credentials over an unencrypted connection?')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByText('Send credentials over an unencrypted connection?')).toBeNull()
    );
    expect(connectWithVariables).not.toHaveBeenCalled();
  });

  it('connects after confirming the cleartext prompt for an unparseable JSON auth payload', async () => {
    const id = seed({ url: 'ws://insecure.local', authMode: 'json', authJson: '{bad' });
    render(<SocketIOClient />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send anyway' }));
    await waitFor(() => expect(connectWithVariables).toHaveBeenCalledWith(id));
  });

  it('treats a parsed JSON auth payload with values as credentials', async () => {
    seed({ url: 'ws://insecure.local', authMode: 'json', authJson: '{"token":"t"}' });
    render(<SocketIOClient />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('button', { name: 'Send anyway' })).toBeInTheDocument();
  });

  it('opens the Options panel automatically when something is configured and toggles it', () => {
    seed({ url: 'https://srv', query: [kv('a', '1')], transports: ['polling'] });
    render(<SocketIOClient />);
    const toggle = screen.getByRole('button', { name: /Options/ });
    expect(toggle).toHaveTextContent('(2)');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('socketio-connection-options')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByTestId('socketio-connection-options')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByTestId('socketio-connection-options')).toBeInTheDocument();
  });

  it('labels transports as "auto" when none is pinned and joins them otherwise', () => {
    const id = seed({ url: 'https://srv', transports: [] });
    const { rerender } = render(<SocketIOClient />);
    expect(screen.getByText('auto')).toBeInTheDocument();
    act(() => {
      useSocketIOStore.getState().updateConnectionField(id, 'transports', ['websocket', 'polling']);
    });
    rerender(<SocketIOClient />);
    expect(screen.getByText('websocket+polling')).toBeInTheDocument();
  });

  it('toggles auto-reconnect while disconnected', () => {
    const id = seed({ url: 'https://srv', autoReconnect: true });
    render(<SocketIOClient />);
    fireEvent.click(screen.getByRole('switch', { name: 'Auto-reconnect' }));
    expect(conn(id).autoReconnect).toBe(false);
  });
});

describe('SocketIOClient — live status', () => {
  it('shows CONNECTING with the read-only URL and disconnects via the manager', () => {
    const id = seed({ url: 'https://srv', namespace: '/chat', status: 'connecting' });
    render(<SocketIOClient />);
    expect(screen.getByTestId('socketio-status')).toHaveTextContent('CONNECTING');
    expect(screen.queryByRole('textbox', { name: 'Namespace' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Options/ })).toBeNull();
    expect(screen.getByText('https://srv/chat')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(socketioManager.disconnect).toHaveBeenCalledWith(id);
  });

  it('shows reconnect count without a max when attempts are unlimited', () => {
    seed({
      url: 'https://srv',
      status: 'reconnecting',
      reconnectAttemptCount: 3,
      reconnectionAttempts: Number.POSITIVE_INFINITY,
    });
    render(<SocketIOClient />);
    expect(screen.getByTestId('socketio-status')).toHaveTextContent('RECONNECTING (3)');
  });

  it('shows uptime once connected', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    vi.setSystemTime(now);
    seed({ url: 'https://srv', status: 'connected', lastConnectedAt: now - 3_725_000 });
    render(<SocketIOClient />);
    expect(screen.getByText('1h 2m')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText('1h 2m')).toBeInTheDocument();
  });

  it('formats short uptimes as minutes+seconds and seconds', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    vi.setSystemTime(now);
    const id = seed({ url: 'https://srv', status: 'connected', lastConnectedAt: now - 125_000 });
    const { unmount } = render(<SocketIOClient />);
    expect(screen.getByText('2m 5s')).toBeInTheDocument();
    unmount();
    act(() => {
      useSocketIOStore.getState().updateConnectionField(id, 'lastConnectedAt', now - 9_000);
    });
    render(<SocketIOClient />);
    expect(screen.getByText('9s')).toBeInTheDocument();
  });
});

describe('SocketIOClient — event log', () => {
  it('shows the empty state, then rows with direction tags, sizes and ack markers', () => {
    const big = 'x'.repeat(2048);
    const huge = 'y'.repeat(1024 * 1024 + 10);
    seed({
      url: 'https://srv',
      events: [
        ev({ direction: 'sent', eventName: 'hello', args: ['hi'], ackId: 'a1' }),
        ev({ direction: 'received', eventName: 'reply', args: [{ big }] }),
        ev({ direction: 'ack', eventName: 'hello', args: [1, 2], ackId: 'a1', ackStatus: 'ok' }),
        ev({ direction: 'system', eventName: 'connect', args: [] }),
        ev({ direction: 'received', eventName: 'ask', args: ['q'], serverAckId: 's1' }),
        ev({
          direction: 'received',
          eventName: 'asked',
          args: ['q'],
          serverAckId: 's2',
          serverAckReplied: true,
        }),
        ev({ direction: 'received', eventName: 'bulk', args: [huge] }),
      ],
    });
    render(<SocketIOClient />);
    const rows = screen.getAllByTestId('socketio-event-row');
    expect(rows).toHaveLength(7);
    expect(rows[0]).toHaveTextContent('→ tx');
    expect(rows[0]).toHaveTextContent('ack:pending "hi"');
    expect(rows[1]).toHaveTextContent('← rx');
    expect(rows[1]).toHaveTextContent('KB');
    expect(rows[1]).toHaveTextContent('…');
    expect(rows[2]).toHaveTextContent('ack:ok [1,2]');
    expect(rows[3]).toHaveTextContent('sys');
    expect(rows[3]).toHaveTextContent('2 B');
    expect(rows[4]).toHaveTextContent('ACK?');
    expect(rows[5]).toHaveTextContent('ACKED');
    expect(rows[6]).toHaveTextContent('MB');
    // Stats count sent vs received (acks/system excluded).
    expect(screen.getByText('(7)')).toBeInTheDocument();
  });

  it('shows the no-events hint when empty, and a filter hint when nothing matches', () => {
    const id = seed({ url: 'https://srv' });
    const { rerender } = render(<SocketIOClient />);
    expect(
      screen.getByText('No events yet. Connect and emit to see them here.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear events' })).toBeDisabled();

    act(() => {
      useSocketIOStore.setState((s) => ({
        connections: {
          ...s.connections,
          [id]: { ...s.connections[id]!, events: [ev({ direction: 'sent' })] },
        },
        eventFilter: 'received',
      }));
    });
    rerender(<SocketIOClient />);
    expect(screen.getByText('No events match the current filter.')).toBeInTheDocument();
  });

  it('exports the filtered events as JSON', async () => {
    const blobs: Blob[] = [];
    const create = vi.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:x';
    });
    const revoke = vi.fn();
    const original = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    onTestFinished(() => {
      Object.assign(URL, original);
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    seed({
      url: 'https://srv',
      events: [ev({ direction: 'sent', eventName: 'kept', args: [1] })],
    });
    render(<SocketIOClient />);
    const trigger = screen.getByRole('button', { name: 'Download events' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(await screen.findByText('Export as JSON'));
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:x');
    const text = await blobs[0]!.text();
    expect(text).toContain('kept');
    expect(text).toContain('socket.io');
    click.mockRestore();
  });

  it('filters by the search box', async () => {
    seed({
      url: 'https://srv',
      events: [ev({ eventName: 'alpha' }), ev({ eventName: 'beta' })],
    });
    render(<SocketIOClient />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search events' }), {
      target: { value: 'beta' },
    });
    expect(useSocketIOStore.getState().searchQuery).toBe('beta');
    await waitFor(() => expect(screen.getAllByTestId('socketio-event-row')).toHaveLength(1));
  });

  it('selects an event to inspect its args, closes it, and clears the log', () => {
    const id = seed({
      url: 'https://srv',
      events: [
        ev({ eventName: 'one', args: [{ a: 1 }] }),
        ev({ eventName: 'many', args: [1, 'two'] }),
        ev({ eventName: 'none', args: [] }),
      ],
    });
    const { container } = render(<SocketIOClient />);
    expect(screen.getByText('Select an event to inspect it.')).toBeInTheDocument();
    const rows = screen.getAllByTestId('socketio-event-row');
    const inspected = () => container.querySelector('pre')?.textContent;

    fireEvent.click(rows[0]!);
    expect(inspected()).toBe('{\n  "a": 1\n}');
    expect(screen.getByText(/one ·/)).toBeInTheDocument();
    fireEvent.click(rows[1]!);
    expect(inspected()).toBe('[\n  1,\n  "two"\n]');
    fireEvent.click(rows[2]!);
    expect(inspected()).toBe('(no args)');

    fireEvent.click(screen.getByRole('button', { name: 'Close selected event' }));
    expect(screen.getByText('Select an event to inspect it.')).toBeInTheDocument();

    fireEvent.click(rows[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Clear events' }));
    expect(conn(id).events).toHaveLength(0);
    expect(screen.getByText('Select an event to inspect it.')).toBeInTheDocument();
  });

  it('falls back to String() for args that cannot be JSON-serialised', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    seed({
      url: 'https://srv',
      events: [
        ev({ eventName: 'cyc', args: [cyclic] }),
        ev({ eventName: 'cyc2', args: [cyclic, 1] }),
      ],
    });
    render(<SocketIOClient />);
    const rows = screen.getAllByTestId('socketio-event-row');
    expect(rows[0]).toHaveTextContent('[object Object]');
    expect(rows[1]).toHaveTextContent('[object Object], 1');
    fireEvent.click(rows[0]!);
    expect(screen.getAllByText('[object Object]').length).toBeGreaterThan(1);
    fireEvent.click(rows[1]!);
    expect(screen.getAllByText('[object Object], 1').length).toBeGreaterThan(1);
  });

  it('freezes the view and reports events that arrived since', () => {
    const id = seed({ url: 'https://srv', events: [ev({ eventName: 'first' })] });
    const { rerender } = render(<SocketIOClient />);
    fireEvent.click(screen.getByRole('button', { name: 'Freeze message view' }));
    act(() => {
      useSocketIOStore.setState((s) => ({
        connections: {
          ...s.connections,
          [id]: {
            ...s.connections[id]!,
            events: [
              ...s.connections[id]!.events,
              ev({ eventName: 'second', timestamp: Date.now() + 10_000 }),
            ],
          },
        },
      }));
    });
    rerender(<SocketIOClient />);
    expect(screen.getAllByTestId('socketio-event-row')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Resume live messages' }));
    expect(screen.getAllByTestId('socketio-event-row')).toHaveLength(2);
  });

  it('offers the ack reply for a server-requested ack on the selected event', () => {
    const id = seed({
      url: 'https://srv',
      status: 'connected',
      events: [ev({ eventName: 'ask', serverAckId: 'srv-1' })],
    });
    render(<SocketIOClient />);
    fireEvent.click(screen.getByTestId('socketio-event-row'));
    const reply = screen.getByTestId('socketio-ack-reply');
    fireEvent.click(within(reply).getByRole('button', { name: /Send ack/ }));
    expect(replyAckWithVariables).toHaveBeenCalledWith(id, 'srv-1', '"ok"');
  });
});

describe('SocketIOClient — compose', () => {
  it('disables the composer while disconnected', () => {
    seed({ url: 'https://srv' });
    render(<SocketIOClient />);
    expect(screen.getByRole('textbox', { name: 'Event name' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Emit$/ })).toBeDisabled();
  });

  it('emits with the composer content, options and ack flag; shows errors', () => {
    const id = seed({ url: 'https://srv', status: 'connected' });
    render(<SocketIOClient />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Event name' }), {
      target: { value: 'chat' },
    });
    const args = screen.getByRole('textbox', { name: 'Emit arguments (JSON)' });
    fireEvent.change(args, { target: { value: '[1,2]' } });
    expect(screen.getByText('5 B')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('switch', { name: 'Request acknowledgement for emitted events' })
    );
    fireEvent.click(screen.getByRole('button', { name: /Emit$/ }));
    expect(emitWithVariables).toHaveBeenCalledWith(id, {
      eventName: 'chat',
      args: '[1,2]',
      ack: true,
      options: conn(id).emitOptions,
    });

    vi.mocked(emitWithVariables).mockReturnValueOnce({ ok: false, error: 'Unexpected token' });
    fireEvent.keyDown(args, { key: 'Enter', ctrlKey: true });
    expect(screen.getByText('JSON error: Unexpected token')).toBeInTheDocument();

    // Plain Enter does not emit; Cmd+Enter does and clears the error.
    fireEvent.keyDown(args, { key: 'Enter' });
    expect(emitWithVariables).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(args, { key: 'Enter', metaKey: true });
    expect(emitWithVariables).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/JSON error/)).toBeNull();
  });

  it('disables Emit for a blank event name', () => {
    seed({ url: 'https://srv', status: 'connected' });
    render(<SocketIOClient />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Event name' }), {
      target: { value: '   ' },
    });
    expect(screen.getByRole('button', { name: /Emit$/ })).toBeDisabled();
  });

  it('saves, loads and sends emit templates', () => {
    const id = seed({
      url: 'https://srv',
      status: 'connected',
      templates: [{ id: 't1', name: 'Ping', eventName: 'ping', args: '{"x":1}', ack: true }],
    });
    render(<SocketIOClient />);
    const savedToggle = screen.getByRole('button', { name: /Saved/ });
    expect(savedToggle).toHaveTextContent('(1)');
    fireEvent.click(savedToggle);
    const list = screen.getByTestId('message-template-list');
    expect(within(list).getByText(/ping · ack · \{"x":1\}/)).toBeInTheDocument();

    fireEvent.click(within(list).getByRole('button', { name: 'Send Ping' }));
    expect(emitWithVariables).toHaveBeenCalledWith(id, {
      eventName: 'ping',
      args: '{"x":1}',
      ack: true,
      options: conn(id).emitOptions,
    });

    fireEvent.click(within(list).getByTitle('Load into composer (Shift+Enter to send)'));
    expect(screen.getByRole('textbox', { name: 'Event name' })).toHaveValue('ping');
    expect(screen.getByRole('textbox', { name: 'Emit arguments (JSON)' })).toHaveValue('{"x":1}');

    fireEvent.click(within(list).getByRole('button', { name: /Save current/ }));
    expect(conn(id).templates).toHaveLength(2);
    expect(conn(id).templates[1]).toMatchObject({ eventName: 'ping', args: '{"x":1}', ack: true });

    fireEvent.click(savedToggle);
    expect(screen.queryByTestId('message-template-list')).toBeNull();
  });

  it('does not save a template when the event name is blank', () => {
    const id = seed({ url: 'https://srv', status: 'connected' });
    render(<SocketIOClient />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Event name' }), {
      target: { value: ' ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Saved/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save current/ }));
    expect(conn(id).templates).toHaveLength(0);
  });
});
