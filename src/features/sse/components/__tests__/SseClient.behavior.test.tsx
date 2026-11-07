import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useHistoryStore } from '@/store/useHistoryStore';
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
    useCollectionStore.setState({ collections: [] });
    useRequestStore.setState({ tabs: [], activeTabId: null, isLoading: false });
    useSseStore.setState({
      connections: {},
      summaries: {},
      activeConnectionId: null,
      connectionByTabId: {},
      searchQuery: '',
    });
  });

  it('renders nothing without an SSE tab', () => {
    const { container } = render(<SseClient />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reports a refused credential in the log and does not connect', async () => {
    const user = userEvent.setup();
    openSse({ auth: { type: 'oauth2', oauth2: { accessToken: '}}', tokenType: '{{sec' } } });
    render(<SseClient />);
    await user.click(screen.getByRole('button', { name: 'Start SSE stream' }));
    expect(manager.connect).not.toHaveBeenCalled();
    const log = useSseStore.getState().getFilteredLog(activeId());
    expect(log.at(-1)).toMatchObject({
      kind: 'system',
      message: expect.stringMatching(/^Connection failed: .*variable reference/),
    });
  });

  it('names an API key header for redirects', async () => {
    const user = userEvent.setup();
    openSse({ auth: { type: 'api-key', apiKey: { key: 'X-Unusual', value: 'k', in: 'header' } } });
    render(<SseClient />);
    await user.click(screen.getByRole('button', { name: 'Start SSE stream' }));
    expect(manager.connect.mock.calls[0]?.[3]).toMatchObject({
      stripOnOriginChange: ['X-Unusual'],
    });
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

  it('resolves collection and folder variables and inherits folder auth', async () => {
    const user = userEvent.setup();
    openSse({ url: 'https://{{host}}/events', params: [], headers: [] });
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Col',
          variables: [{ id: 'cv', key: 'host', value: 'col.example.com', enabled: true }],
          items: [
            {
              id: 'f1',
              name: 'F',
              type: 'folder',
              auth: { type: 'bearer', bearer: { token: '{{folderTok}}' } },
              variables: [{ id: 'fv', key: 'folderTok', value: 'ft', enabled: true }],
              items: [
                {
                  id: 'item',
                  name: 'R',
                  type: 'request',
                  request: useRequestStore.getState().tabs[0]?.request as SseRequest,
                },
              ],
            },
          ],
        },
      ],
    });
    render(<SseClient />);
    await user.click(screen.getByRole('button', { name: 'Start SSE stream' }));
    expect(manager.connect).toHaveBeenCalledWith(
      activeId(),
      'https://col.example.com/events',
      { Authorization: 'Bearer ft' },
      { reconnectOnResume: true, autoReconnect: true }
    );
  });

  it('refuses to connect and says why when a variable cannot be resolved', async () => {
    const user = userEvent.setup();
    openSse({ params: [] });
    const original = useEnvironmentStore.getState().resolveVariables;
    useEnvironmentStore.setState({
      resolveVariables: () => {
        throw new Error('boom');
      },
    });
    render(<SseClient />);
    await user.click(screen.getByRole('button', { name: 'Start SSE stream' }));
    useEnvironmentStore.setState({ resolveVariables: original });
    expect(manager.connect).not.toHaveBeenCalled();
    expect(
      useSseStore
        .getState()
        .connections[activeId()]?.log.map((entry) => JSON.stringify(entry))
        .join()
    ).toContain('boom');
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

  it('keeps a background tab streaming and gives each SSE tab its own connection', async () => {
    openSse();
    const firstTab = useRequestStore.getState().activeTabId!;
    const { unmount } = render(<SseClient />);
    await ready();
    const first = activeId();
    act(() => {
      useRequestStore.getState().openTab({
        id: 'sse-2',
        name: 'Other',
        type: 'sse',
        url: 'https://other.example.com/events',
        headers: [],
        params: [],
        auth: { type: 'none' },
      } as SseRequest);
    });
    await screen.findByDisplayValue('https://other.example.com/events');
    const second = activeId();
    expect(second).not.toBe(first);
    unmount();
    expect(manager.disconnect).not.toHaveBeenCalled();
    expect(useSseStore.getState().connectionByTabId[firstTab]).toBe(first);
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

    await user.click(screen.getByRole('button', { name: /Options/ }));
    expect(screen.getByText('table:header')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: /Auto-reconnect/ }));
    expect(useRequestStore.getState().tabs[0]?.request).toMatchObject({ autoReconnect: false });
    await user.click(screen.getByRole('button', { name: /Options/ }));
    expect(screen.queryByText('table:header')).not.toBeInTheDocument();
  });

  it('counts every configured option on the Options toggle (S12)', async () => {
    openSse({ auth: { type: 'bearer', bearer: { token: 't' } }, autoReconnect: false });
    render(<SseClient />);
    await ready();
    // 1 enabled header + 1 keyed param + auth + auto-reconnect off
    expect(screen.getByRole('button', { name: 'Options (4)' })).toBeInTheDocument();
  });

  it('confirms before sending credentials over http:// (S12)', async () => {
    const user = userEvent.setup();
    openSse({
      url: 'http://stream.example.com/events',
      auth: { type: 'bearer', bearer: { token: 'tok' } },
    });
    render(<SseClient />);
    await user.click(screen.getByRole('button', { name: 'Start SSE stream' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(manager.connect).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(manager.connect).not.toHaveBeenCalled();
  });

  it('does not ask for http:// without credentials (S12)', async () => {
    const user = userEvent.setup();
    openSse({ url: 'http://stream.example.com/events', headers: [], params: [] });
    render(<SseClient />);
    await user.click(screen.getByRole('button', { name: 'Start SSE stream' }));
    expect(manager.connect).toHaveBeenCalled();
  });

  it('records one redacted history entry once the stream connects (S14)', async () => {
    const user = userEvent.setup();
    await useHistoryStore.persist.rehydrate();
    useHistoryStore.setState({ history: [] });
    openSse({
      headers: [{ id: 'h1', key: 'Authorization', value: 'Bearer inline-secret', enabled: true }],
    });
    render(<SseClient />);
    await user.click(screen.getByRole('button', { name: 'Start SSE stream' }));
    expect(useHistoryStore.getState().history).toHaveLength(0);
    act(() => {
      useSseStore.getState().updateConnectionStatus(activeId(), 'connected');
    });
    act(() => {
      useSseStore.getState().updateConnectionStatus(activeId(), 'reconnecting');
    });
    act(() => {
      useSseStore.getState().updateConnectionStatus(activeId(), 'connected');
    });
    const history = useHistoryStore.getState().history;
    expect(history).toHaveLength(1);
    expect(history[0]?.request.type).toBe('sse');
    expect(history[0]?.resolvedUrl).toBe('https://stream.example.com/events?topic=news');
    expect(JSON.stringify(history[0])).not.toContain('inline-secret');
  });

  it('still records history when the stream connects after its tab went to the background', async () => {
    const user = userEvent.setup();
    await useHistoryStore.persist.rehydrate();
    useHistoryStore.setState({ history: [] });
    openSse();
    const { unmount } = render(<SseClient />);
    await user.click(screen.getByRole('button', { name: 'Start SSE stream' }));
    const connectionId = activeId();
    unmount(); // e.g. the user switched to a non-SSE tab before it connected
    act(() => {
      useSseStore.getState().updateConnectionStatus(connectionId, 'connected');
    });
    expect(useHistoryStore.getState().history).toHaveLength(1);
  });
});
