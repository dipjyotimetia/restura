import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/shared/platform', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, isElectron: vi.fn(() => false) };
});

import {
  type SocketIOConnection,
  useSocketIOStore,
} from '@/features/socketio/store/useSocketIOStore';
import { isElectron } from '@/lib/shared/platform';
import { countConfiguredOptions, SocketIOConnectionOptions } from '../SocketIOConnectionOptions';

let connId = '';

function seed(patch: Partial<SocketIOConnection> = {}) {
  connId = useSocketIOStore.getState().createConnection('https://srv');
  useSocketIOStore.setState((s) => ({
    connections: { ...s.connections, [connId]: { ...s.connections[connId]!, ...patch } },
  }));
  return connId;
}

const conn = () => useSocketIOStore.getState().connections[connId]!;

/** Re-reads the connection from the store, as SocketIOClient does. */
function Harness() {
  const c = useSocketIOStore((s) => s.connections[connId]);
  return c ? <SocketIOConnectionOptions connection={c} /> : null;
}

const kv = (key: string, value: string) => ({ id: key, key, value, enabled: true });

beforeEach(() => {
  vi.mocked(isElectron).mockReturnValue(false);
  useSocketIOStore.setState({ connections: {}, connectionByTabId: {} });
});

describe('countConfiguredOptions', () => {
  it('is 0 for a fresh connection', () => {
    seed();
    expect(countConfiguredOptions(conn())).toBe(0);
  });

  it('counts kv auth rows, query, headers, a custom path and a pinned transport', () => {
    seed({
      auth: [kv('a', '1'), kv('b', '2')],
      query: [kv('q', '1')],
      extraHeaders: [kv('h', '1')],
      path: '/custom',
      transports: ['websocket'],
    });
    expect(countConfiguredOptions(conn())).toBe(6);
  });

  it('counts JSON auth once, and not when empty or "{}"', () => {
    seed({ authMode: 'json', authJson: '{"t":1}', auth: [kv('ignored', 'x')] });
    expect(countConfiguredOptions(conn())).toBe(1);
    expect(countConfiguredOptions({ ...conn(), authJson: ' {} ' })).toBe(0);
    expect(countConfiguredOptions({ ...conn(), authJson: '   ' })).toBe(0);
    expect(countConfiguredOptions({ ...conn(), path: '' })).toBe(1);
  });
});

describe('SocketIOConnectionOptions — auth', () => {
  it('switches between key/value and JSON auth modes', () => {
    seed();
    render(<Harness />);
    const kvBtn = screen.getByRole('button', { name: 'Key/value' });
    const jsonBtn = screen.getByRole('button', { name: 'JSON' });
    expect(kvBtn).toHaveAttribute('aria-pressed', 'true');
    expect(jsonBtn).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Add auth field')).toBeInTheDocument();

    fireEvent.click(jsonBtn);
    expect(conn().authMode).toBe('json');
    expect(screen.getByRole('button', { name: 'JSON' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox', { name: 'Auth payload (JSON)' })).toHaveValue('{}');
    expect(
      screen.getByText('Any JSON object. {{variables}} are resolved at connect time.')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Key/value' }));
    expect(conn().authMode).toBe('kv');
  });

  it('adds a kv auth row through the table', () => {
    seed();
    render(<Harness />);
    fireEvent.click(screen.getByText('Add auth field'));
    expect(conn().auth).toHaveLength(1);
  });

  it('reports invalid JSON auth, but not while {{variables}} are unresolved', () => {
    seed({ authMode: 'json' });
    render(<Harness />);
    const box = screen.getByRole('textbox', { name: 'Auth payload (JSON)' });
    fireEvent.change(box, { target: { value: '{"a":' } });
    expect(conn().authJson).toBe('{"a":');
    expect(screen.getByText(/^JSON error:/)).toBeInTheDocument();

    fireEvent.change(box, { target: { value: '{"a": {{token}}' } });
    expect(screen.queryByText(/^JSON error:/)).toBeNull();

    fireEvent.change(box, { target: { value: '{"a":1}' } });
    expect(screen.queryByText(/^JSON error:/)).toBeNull();
  });
});

describe('SocketIOConnectionOptions — query, headers, path, transports', () => {
  it('adds query params and headers', () => {
    seed();
    render(<Harness />);
    fireEvent.click(screen.getByText('Add query param'));
    fireEvent.click(screen.getByText('Add header'));
    expect(conn().query).toHaveLength(1);
    expect(conn().extraHeaders).toHaveLength(1);
  });

  it('warns that browsers drop headers on the WebSocket transport (web only)', () => {
    seed({ extraHeaders: [kv('X-Key', 'v')] });
    const { unmount } = render(<Harness />);
    expect(screen.getByText(/Browsers drop custom headers/)).toBeInTheDocument();
    unmount();

    useSocketIOStore.getState().updateConnectionField(connId, 'transports', ['polling']);
    const second = render(<Harness />);
    expect(screen.queryByText(/Browsers drop custom headers/)).toBeNull();
    second.unmount();

    useSocketIOStore
      .getState()
      .updateConnectionField(connId, 'transports', ['websocket', 'polling']);
    vi.mocked(isElectron).mockReturnValue(true);
    render(<Harness />);
    expect(screen.queryByText(/Browsers drop custom headers/)).toBeNull();
  });

  it('normalises the Engine.IO path on blur', () => {
    seed();
    render(<Harness />);
    const path = screen.getByRole('textbox', { name: 'Engine.IO path' });
    fireEvent.change(path, { target: { value: 'io' } });
    expect(conn().path).toBe('io');
    fireEvent.blur(path);
    expect(conn().path).toBe('/io');
    fireEvent.change(path, { target: { value: '  /x  ' } });
    fireEvent.blur(path);
    expect(conn().path).toBe('/x');
    fireEvent.change(path, { target: { value: '   ' } });
    fireEvent.blur(path);
    expect(conn().path).toBe('/socket.io');
  });

  it('toggles transports in canonical order and keeps at least one', () => {
    seed();
    render(<Harness />);
    const ws = screen.getByRole('switch', { name: 'Transport websocket' });
    const polling = screen.getByRole('switch', { name: 'Transport polling' });
    fireEvent.click(ws);
    expect(conn().transports).toEqual(['polling']);
    // Removing the last transport is refused.
    fireEvent.click(screen.getByRole('switch', { name: 'Transport polling' }));
    expect(conn().transports).toEqual(['polling']);
    fireEvent.click(screen.getByRole('switch', { name: 'Transport websocket' }));
    expect(conn().transports).toEqual(['websocket', 'polling']);
    expect(polling).toBeInTheDocument();
  });
});

describe('SocketIOConnectionOptions — numeric fields', () => {
  it('clamps and rounds integer fields, and ignores empty input', () => {
    seed();
    render(<Harness />);
    const timeout = screen.getByLabelText('Timeout (ms)');
    expect(timeout).toHaveValue(20_000);
    fireEvent.change(timeout, { target: { value: '1500.7' } });
    expect(conn().timeout).toBe(1501);
    fireEvent.change(timeout, { target: { value: '999999' } });
    expect(conn().timeout).toBe(120_000);
    fireEvent.change(timeout, { target: { value: '0' } });
    expect(conn().timeout).toBe(1);
    fireEvent.change(timeout, { target: { value: '' } });
    expect(conn().timeout).toBe(1);
  });

  it('keeps fractional steps for the randomization factor', () => {
    seed();
    render(<Harness />);
    const rand = screen.getByLabelText('Randomization');
    fireEvent.change(rand, { target: { value: '0.3' } });
    expect(conn().randomizationFactor).toBe(0.3);
    fireEvent.change(rand, { target: { value: '7' } });
    expect(conn().randomizationFactor).toBe(1);
  });

  it('edits reconnection tuning and disables it when reconnection is off', () => {
    seed();
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Attempts'), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('Delay (ms)'), { target: { value: '250' } });
    fireEvent.change(screen.getByLabelText('Max delay (ms)'), { target: { value: '9000' } });
    expect(conn()).toMatchObject({
      reconnectionAttempts: 12,
      reconnectionDelay: 250,
      reconnectionDelayMax: 9000,
    });

    fireEvent.click(screen.getByRole('switch', { name: 'Reconnection' }));
    expect(conn().autoReconnect).toBe(false);
    for (const label of ['Attempts', 'Delay (ms)', 'Max delay (ms)', 'Randomization']) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
  });

  it('renders a non-finite value as empty', () => {
    seed({ reconnectionAttempts: Number.POSITIVE_INFINITY });
    render(<Harness />);
    expect(screen.getByLabelText('Attempts')).toHaveValue(null);
  });
});
