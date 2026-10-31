import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthConfig, KeyValue, SseRequest } from '@/types';

const manager = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
vi.mock('@/features/sse/lib/sseManager', () => ({ sseManager: manager }));

vi.mock('@/components/shared/KeyValueTable', () => ({
  KeyValueTable: ({ itemLabel }: { itemLabel: string; items: KeyValue[] }) => (
    <div>{`table:${itemLabel}`}</div>
  ),
}));
vi.mock('@/features/auth/components/AuthConfig', () => ({
  default: ({ auth }: { auth: AuthConfig }) => <div>{`auth:${auth.type}`}</div>,
}));
vi.mock('@/components/shared/StreamSplit', () => ({
  StreamSplit: ({ config, log }: { config: React.ReactNode; log: React.ReactNode }) => (
    <div>
      {config}
      {log}
    </div>
  ),
}));

import SseClient from '@/features/sse/components/SseClient';
import { useSseStore } from '@/features/sse/store/useSseStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useRequestStore } from '@/store/useRequestStore';

function openSse(patch: Partial<SseRequest> = {}) {
  const req: SseRequest = {
    id: 'sse-1',
    name: 'Stream',
    type: 'sse',
    url: 'https://stream.example.com/events',
    headers: [
      { id: 'h1', key: 'X-One', value: 'a', enabled: true },
      { id: 'h2', key: 'X-Off', value: 'b', enabled: false },
    ],
    params: [
      { id: 'p1', key: 'topic', value: 'news', enabled: true },
      { id: 'p2', key: '', value: 'skipped', enabled: true },
    ],
    auth: { type: 'none' },
    ...patch,
  };
  useRequestStore.getState().openTab(req, { savedRequestId: 'item' });
}

const activeId = () => useSseStore.getState().activeConnectionId!;
const ready = () => screen.findByRole('textbox', { name: 'SSE endpoint URL' });

describe('SseClient behaviour', () => {
  beforeEach(async () => {
    // Let the async persisted-store hydration settle so it can't clobber test state.
    await useSseStore.persist.rehydrate();
    await useRequestStore.persist.rehydrate();
    await useEnvironmentStore.persist.rehydrate();
    manager.connect.mockReset();
    manager.disconnect.mockReset();
    useRequestStore.setState({ tabs: [], activeTabId: null, isLoading: false });
    useSseStore.setState({
      connections: {},
      summaries: {},
      activeConnectionId: null,
      searchQuery: '',
    });
  });

  it('renders nothing without an SSE tab', () => {
    const { container } = render(<SseClient />);
    expect(container).toBeEmptyDOMElement();
  });

  it('connects with auth header, auth query param and resolved variables', async () => {
    const user = userEvent.setup();
    openSse({
      url: 'https://{{host}}/events',
      auth: { type: 'bearer', bearer: { token: 'tok' } },
      autoReconnect: false,
    });
    vi.spyOn(useEnvironmentStore.getState(), 'resolveVariables').mockImplementation((v: string) =>
      v.replace('{{host}}', 'resolved.test')
    );
    useEnvironmentStore.setState({
      resolveVariables: (v: string) => v.replace('{{host}}', 'resolved.test'),
    });
    render(<SseClient />);
    await user.click(screen.getByRole('button', { name: 'Start SSE stream' }));
    expect(manager.connect).toHaveBeenCalledWith(
      activeId(),
      'https://resolved.test/events?topic=news',
      { 'X-One': 'a', Authorization: 'Bearer tok' },
      { reconnectOnResume: true, autoReconnect: false }
    );
  });

  it('adds an api-key credential to the query string', async () => {
    const user = userEvent.setup();
    openSse({
      params: [],
      auth: { type: 'api-key', apiKey: { key: 'k', value: 'v', in: 'query' } },
    });
    render(<SseClient />);
    await user.click(screen.getByRole('button', { name: 'Start SSE stream' }));
    expect(manager.connect.mock.calls[0]?.[1]).toBe('https://stream.example.com/events?k=v');
  });

  it('leaves an unparseable URL untouched for the manager to reject', async () => {
    const user = userEvent.setup();
    openSse({ url: 'not a url' });
    render(<SseClient />);
    await user.click(screen.getByRole('button', { name: 'Start SSE stream' }));
    expect(manager.connect.mock.calls[0]?.[1]).toBe('not a url');
  });

  it('passes the URL through when there are no query params', async () => {
    const user = userEvent.setup();
    openSse({ params: [] });
    render(<SseClient />);
    await user.click(screen.getByRole('button', { name: 'Start SSE stream' }));
    expect(manager.connect.mock.calls[0]?.[1]).toBe('https://stream.example.com/events');
  });

  it('shows Stop while connected and disconnects on click', async () => {
    const user = userEvent.setup();
    openSse();
    render(<SseClient />);
    await ready();
    await act(async () => useSseStore.getState().updateConnectionStatus(activeId(), 'connected'));
    expect(screen.getByText('STREAMING')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop SSE stream' }));
    expect(manager.disconnect).toHaveBeenCalledWith(activeId());
  });

  it('treats reconnecting as an active, stoppable state', async () => {
    openSse();
    render(<SseClient />);
    await ready();
    await act(async () =>
      useSseStore.getState().updateConnectionStatus(activeId(), 'reconnecting')
    );
    expect(screen.getByText('RECONNECTING')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop SSE stream' })).toBeInTheDocument();
  });

  it('disconnects the stream on unmount', async () => {
    openSse();
    const { unmount } = render(<SseClient />);
    await ready();
    const id = activeId();
    unmount();
    expect(manager.disconnect).toHaveBeenCalledWith(id);
  });

  it('clears the log and resets the event filter to all', async () => {
    const user = userEvent.setup();
    openSse({ eventFilter: ['tick'] });
    render(<SseClient />);
    await ready();
    const id = activeId();
    await act(async () => {
      useSseStore.getState().appendEvent(id, { event: 'tick', data: '1' });
      useSseStore.getState().appendEvent(id, { event: 'other', data: '2' });
    });
    // Restored filter is selectable even though it came from the saved request.
    const select = screen.getByRole('combobox', { name: 'Filter by event name' });
    expect(select).toHaveValue('tick');
    await user.selectOptions(select, 'all');
    expect(useRequestStore.getState().tabs[0]?.request).toMatchObject({ eventFilter: undefined });
    expect(screen.getByRole('combobox', { name: 'Filter by event name' })).toHaveValue('all');

    await user.click(screen.getByRole('button', { name: 'Clear log' }));
    expect(useSseStore.getState().connections[id]?.log).toEqual([]);
  });

  it('keeps a saved filter selectable before any matching event arrives', async () => {
    openSse({ eventFilter: ['late'] });
    render(<SseClient />);
    await ready();
    expect(screen.getByRole('option', { name: 'late' })).toBeInTheDocument();
  });

  it('updates search and the auto-reconnect option from the config panel', async () => {
    const user = userEvent.setup();
    openSse();
    render(<SseClient />);
    await ready();
    fireEvent.change(screen.getByLabelText('Search events'), { target: { value: 'abc' } });
    expect(useSseStore.getState().searchQuery).toBe('abc');

    await user.click(screen.getByRole('button', { name: /Headers/ }));
    expect(screen.getByText('table:header')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: /Auto-reconnect/ }));
    expect(useRequestStore.getState().tabs[0]?.request).toMatchObject({ autoReconnect: false });
    await user.click(screen.getByRole('button', { name: /Headers/ }));
    expect(screen.queryByText('table:header')).not.toBeInTheDocument();
  });
});
