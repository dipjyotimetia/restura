import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const themeMock = vi.hoisted(() => ({
  resolvedTheme: 'dark' as string | undefined,
  setTheme: vi.fn(),
}));
vi.mock('next-themes', () => ({ useTheme: () => themeMock }));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

vi.mock('@/lib/shared/platform', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, isElectron: vi.fn(() => false), openExternalUrl: vi.fn() };
});

import { CLOSE_ACTIVE_TAB_EVENT } from '@/components/shared/TabBar';
import { DESKTOP_RELEASES_URL } from '@/components/shared/WebNativeDownloadBanner';
import { REPLAY_ONBOARDING_EVENT } from '@/components/shared/WelcomeOnboarding';
import { openExternalUrl } from '@/lib/shared/platform';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useConsoleStore } from '@/store/useConsoleStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useRequestStore } from '@/store/useRequestStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useUiStore } from '@/store/useUiStore';
import type { Collection, HttpRequest, Request } from '@/types';
import CommandPalette from '../CommandPalette';

let writeText = vi.fn((_text: string) => Promise.resolve());

/** userEvent.setup() installs its own clipboard stub, so ours goes on after it. */
function setupUser() {
  const user = userEvent.setup();
  writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined) as never;
  return user;
}

function httpReq(id: string, overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id,
    name: `Req ${id}`,
    type: 'http',
    method: 'GET',
    url: `https://api.example.com/${id}`,
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...overrides,
  } as HttpRequest;
}

function seedHistory(requests: Request[]) {
  useHistoryStore.setState({
    history: requests.map((request, i) => ({
      id: `h-${i}`,
      request,
      timestamp: 1000 - i,
    })) as never,
  });
}

function option(name: RegExp | string) {
  return screen.getByRole('option', { name });
}

function renderControlled(props: Partial<React.ComponentProps<typeof CommandPalette>> = {}) {
  const onOpenChange = vi.fn();
  const utils = render(<CommandPalette open onOpenChange={onOpenChange} {...props} />);
  return { ...utils, onOpenChange };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  toastMock.success.mockReset();
  themeMock.resolvedTheme = 'dark';
  themeMock.setTheme.mockReset();
  vi.mocked(openExternalUrl).mockReset();
  useRequestStore.setState((s) => ({ ...s, tabs: [], activeTabId: null, closedTabs: [] }));
  useHistoryStore.setState({ history: [] });
  useCollectionStore.setState({ collections: [] });
  useEnvironmentStore.setState({ environments: [], activeEnvironmentId: null });
  useUiStore.setState({ codeGenOpen: false, loadTestOpen: false });
  useConsoleStore.setState({ isExpanded: false });
  useSettingsStore.getState().updateSettings({ sidebarCollapsed: false });
});

describe('CommandPalette open state', () => {
  it('toggles with Cmd/Ctrl+K when uncontrolled', () => {
    render(<CommandPalette />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
    // A plain "k" is ignored.
    fireEvent.keyDown(document, { key: 'k' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reports close through onOpenChange when controlled and ignores Cmd+K', async () => {
    const user = setupUser();
    const { onOpenChange } = renderControlled();
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes after running an action', async () => {
    const user = setupUser();
    const onOpenSettings = vi.fn();
    const { onOpenChange } = renderControlled({ onOpenSettings });
    await user.click(option(/open settings/i));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('CommandPalette recent + requests groups', () => {
  it('lists up to five unique recent requests with name fallbacks and reopens one', async () => {
    const user = setupUser();
    seedHistory([
      httpReq('a'),
      httpReq('a'),
      httpReq('b', { name: '' }),
      httpReq('c', { name: '', url: '' }),
      { ...httpReq('d'), type: 'grpc', name: '', url: '' } as unknown as Request,
      httpReq('e'),
      httpReq('f'),
    ]);
    renderControlled();
    const recent = screen.getByRole('group', { name: 'Recent' });
    const rows = within(recent).getAllByRole('option');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Req a'),
      expect.stringContaining('https://api.example.com/b'),
      expect.stringContaining('GET'),
      expect.stringContaining('GRPC'),
      expect.stringContaining('Req e'),
    ]);
    await user.click(rows[0]!);
    const { tabs, activeTabId } = useRequestStore.getState();
    expect(tabs.find((t) => t.id === activeTabId)?.request.url).toBe('https://api.example.com/a');
  });

  it('flattens collection folders into paths, marks recents, and opens the saved request', async () => {
    const user = setupUser();
    const collection = {
      id: 'col',
      name: 'Shop',
      items: [
        {
          id: 'folder',
          type: 'folder',
          name: 'Orders',
          items: [{ id: 'item-1', type: 'request', name: 'List orders', request: httpReq('r1') }],
        },
        {
          id: 'item-2',
          type: 'request',
          name: 'Stream',
          request: { ...httpReq('r2'), type: 'grpc' },
        },
        { id: 'empty-folder', type: 'folder', name: 'Empty' },
        { id: 'item-3', type: 'request', name: 'No payload' },
      ],
    } as unknown as Collection;
    useCollectionStore.setState({ collections: [collection] });
    seedHistory([{ ...httpReq('item-1') }]);
    renderControlled();

    const requests = screen.getByRole('group', { name: 'Requests' });
    const rows = within(requests).getAllByRole('option');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('List orders');
    expect(rows[0]).toHaveTextContent('Shop / Orders');
    expect(rows[0]).toHaveTextContent('RECENT');
    expect(rows[1]).toHaveTextContent('gRPC');
    expect(rows[1]).not.toHaveTextContent('RECENT');

    await user.click(rows[0]!);
    const { tabs } = useRequestStore.getState();
    expect(tabs.some((t) => t.savedRequestId === 'item-1')).toBe(true);
  });
});

describe('CommandPalette actions', () => {
  function seedActiveHttpTab(withResponse = false) {
    const id = useRequestStore.getState().createNewRequest('http');
    useRequestStore.setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              request: { ...t.request, url: 'https://api.example.com/users' },
              ...(withResponse && { response: { body: '{"ok":true}' } as never }),
            }
          : t
      ),
    }));
    return id;
  }

  it('runs callbacks for send and import', async () => {
    const user = setupUser();
    const onSendRequest = vi.fn();
    const onOpenImport = vi.fn();
    renderControlled({ onSendRequest, onOpenImport });
    await user.click(option(/send request/i));
    await user.click(option(/import collection/i));
    expect(onSendRequest).toHaveBeenCalledTimes(1);
    expect(onOpenImport).toHaveBeenCalledTimes(1);
  });

  it('hides tab-scoped actions without an active tab', () => {
    renderControlled();
    expect(screen.queryByRole('option', { name: /close tab/i })).toBeNull();
    expect(screen.queryByRole('option', { name: /copy response body/i })).toBeNull();
    expect(screen.queryByRole('option', { name: /generate code/i })).toBeNull();
    expect(screen.queryByRole('option', { name: /send request/i })).toBeNull();
  });

  it('copies the response body and opens code-gen / load-test for an HTTP tab', async () => {
    const user = setupUser();
    seedActiveHttpTab(true);
    renderControlled();
    await user.click(option(/copy response body/i));
    expect(writeText).toHaveBeenCalledWith('{"ok":true}');
    await user.click(option(/generate code/i));
    expect(useUiStore.getState().codeGenOpen).toBe(true);
    await user.click(option(/load test/i));
    expect(useUiStore.getState().loadTestOpen).toBe(true);
  });

  it('copies the active request as cURL', async () => {
    const user = setupUser();
    seedActiveHttpTab();
    renderControlled();
    await user.click(option(/copy as curl/i));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('curl'));
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('https://api.example.com/users')
    );
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Copied as cURL'));
  });

  it('does not copy cURL when the active tab resolves to a non-HTTP request', async () => {
    const user = setupUser();
    seedActiveHttpTab();
    renderControlled();
    const state = useRequestStore.getState();
    vi.spyOn(state, 'getActiveTab').mockReturnValue({
      ...state.tabs[0]!,
      request: { ...state.tabs[0]!.request, type: 'grpc' } as never,
    });
    await user.click(option(/copy as curl/i));
    expect(writeText).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('hides HTTP-only actions on a connection-mode tab', () => {
    const id = useRequestStore.getState().createNewRequest('http');
    useRequestStore.setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, modeOverride: 'websocket' } : t)),
    }));
    renderControlled();
    expect(screen.queryByRole('option', { name: /copy as curl/i })).toBeNull();
    expect(option(/duplicate tab/i)).toBeInTheDocument();
  });

  it('closes, duplicates and reopens tabs', async () => {
    const user = setupUser();
    const id = seedActiveHttpTab();
    const closeListener = vi.fn();
    window.addEventListener(CLOSE_ACTIVE_TAB_EVENT, closeListener);
    const reopen = vi.spyOn(useRequestStore.getState(), 'reopenClosedTab');
    renderControlled();
    await user.click(option(/^close tab/i));
    expect(closeListener).toHaveBeenCalledTimes(1);
    window.removeEventListener(CLOSE_ACTIVE_TAB_EVENT, closeListener);

    await user.click(option(/duplicate tab/i));
    expect(useRequestStore.getState().tabs).toHaveLength(2);
    expect(useRequestStore.getState().tabs[0]?.id).toBe(id);

    await user.click(option(/reopen closed tab/i));
    expect(reopen).toHaveBeenCalledTimes(1);
  });

  it('toggles the sidebar and the network console', async () => {
    const user = setupUser();
    renderControlled();
    await user.click(option(/toggle sidebar/i));
    expect(useSettingsStore.getState().settings.sidebarCollapsed).toBe(true);
    await user.click(option(/toggle network console/i));
    expect(useConsoleStore.getState().isExpanded).toBe(true);
  });

  it('opens the desktop download page on web', async () => {
    const user = setupUser();
    renderControlled();
    await user.click(option(/get the desktop app/i));
    expect(openExternalUrl).toHaveBeenCalledWith(DESKTOP_RELEASES_URL);
  });

  it('confirms before clearing history', async () => {
    const user = setupUser();
    seedHistory([httpReq('a')]);
    const { onOpenChange } = renderControlled();
    await user.click(option(/clear history/i));
    // keepOpen: the palette stays open for the confirm.
    expect(onOpenChange).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Clear history' }));
    expect(useHistoryStore.getState().history).toEqual([]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cancelling the clear confirm keeps history and closes the palette', async () => {
    const user = setupUser();
    seedHistory([httpReq('a')]);
    const { onOpenChange } = renderControlled();
    await user.click(option(/clear history/i));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: /cancel/i })
    );
    expect(useHistoryStore.getState().history).toHaveLength(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('CommandPalette new + environments + settings', () => {
  it('creates a request for request modes and hands connection modes to onChangeMode', async () => {
    const user = setupUser();
    const onChangeMode = vi.fn();
    renderControlled({ onChangeMode });
    await user.click(option(/new grpc request/i));
    const { tabs, activeTabId } = useRequestStore.getState();
    expect(tabs.find((t) => t.id === activeTabId)?.request.type).toBe('grpc');
    await user.click(option(/new ws/i));
    expect(onChangeMode).toHaveBeenCalledWith('websocket');
  });

  it('tolerates a connection mode without an onChangeMode handler', async () => {
    const user = setupUser();
    renderControlled();
    await user.click(option(/new socket\.io/i));
    expect(useRequestStore.getState().tabs).toHaveLength(0);
  });

  it('switches and clears the active environment, marking the active one', async () => {
    const user = setupUser();
    useEnvironmentStore.setState({
      environments: [
        { id: 'dev', name: 'Dev', variables: [] },
        { id: 'prod', name: 'Prod', variables: [] },
      ],
      activeEnvironmentId: 'dev',
    });
    renderControlled();
    const group = screen.getByRole('group', { name: 'Environments' });
    expect(
      within(group)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['No environment', 'Dev', 'Prod']);
    await user.click(option('Prod'));
    expect(useEnvironmentStore.getState().activeEnvironmentId).toBe('prod');
    await user.click(option('No environment'));
    expect(useEnvironmentStore.getState().activeEnvironmentId).toBeNull();
  });

  it('omits the environments group when there are none', () => {
    renderControlled();
    expect(screen.queryByRole('group', { name: 'Environments' })).toBeNull();
  });

  it('switches dark → light and keeps the persisted setting in sync', async () => {
    const user = setupUser();
    renderControlled();
    await user.click(option(/switch to light theme/i));
    expect(themeMock.setTheme).toHaveBeenCalledWith('light');
    expect(useSettingsStore.getState().settings.theme).toBe('light');
  });

  it('switches light → dark', async () => {
    const user = setupUser();
    themeMock.resolvedTheme = 'light';
    renderControlled();
    await user.click(option(/switch to dark theme/i));
    expect(themeMock.setTheme).toHaveBeenCalledWith('dark');
  });

  it('opens shortcuts, environments and the welcome tour', async () => {
    const user = setupUser();
    const onOpenShortcuts = vi.fn();
    const onOpenEnvironments = vi.fn();
    const tour = vi.fn();
    window.addEventListener(REPLAY_ONBOARDING_EVENT, tour);
    renderControlled({ onOpenShortcuts, onOpenEnvironments });
    await user.click(option(/keyboard shortcuts/i));
    await user.click(option(/manage environments/i));
    await user.click(option(/show welcome tour/i));
    window.removeEventListener(REPLAY_ONBOARDING_EVENT, tour);
    expect(onOpenShortcuts).toHaveBeenCalledTimes(1);
    expect(onOpenEnvironments).toHaveBeenCalledTimes(1);
    expect(tour).toHaveBeenCalledTimes(1);
  });
});

describe('CommandPalette search + keyboard', () => {
  it('filters fuzzily, reports the count, and shows a no-match message', async () => {
    const user = setupUser();
    renderControlled();
    const input = screen.getByRole('combobox');
    await user.type(input, 'welcome tour');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByText('1 result')).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, 'zzzzqqq');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/no matches for/i)).toHaveTextContent('zzzzqqq');
    expect(screen.getByText('0 results')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });

  it('orders matches by group and searches the request path too', async () => {
    const user = setupUser();
    useCollectionStore.setState({
      collections: [
        {
          id: 'col',
          name: 'Billing',
          items: [{ id: 'inv', type: 'request', name: 'Invoices', request: httpReq('inv') }],
        } as unknown as Collection,
      ],
    });
    renderControlled();
    await user.type(screen.getByRole('combobox'), 'billing');
    const rows = screen.getAllByRole('option');
    expect(rows[0]).toHaveTextContent('Invoices');
  });

  it('moves the highlight with arrows / hover and runs it with Enter', async () => {
    const user = setupUser();
    const onOpenSettings = vi.fn();
    const onOpenShortcuts = vi.fn();
    renderControlled({ onOpenSettings, onOpenShortcuts });
    const input = screen.getByRole('combobox');
    await user.type(input, 'open settings');
    const target = option(/open settings/i);
    expect(target).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', target.id);

    await user.clear(input);
    await user.keyboard('{ArrowUp}');
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');

    const shortcuts = option(/keyboard shortcuts/i);
    fireEvent.mouseEnter(shortcuts);
    expect(shortcuts).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(onOpenShortcuts).toHaveBeenCalledTimes(1);
  });

  it('clamps ArrowDown at the last row and Enter on no match is a no-op', async () => {
    const user = setupUser();
    const onOpenSettings = vi.fn();
    renderControlled({ onOpenSettings });
    const input = screen.getByRole('combobox');
    await user.type(input, 'open settings');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(option(/open settings/i)).toHaveAttribute('aria-selected', 'true');
    await user.type(input, 'zzzz');
    await user.keyboard('{Enter}');
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it('ignores keys other than arrows / Enter / Space', () => {
    const onOpenEnvironments = vi.fn();
    renderControlled({ onOpenEnvironments });
    const row = option(/manage environments/i);
    fireEvent.mouseEnter(row);
    fireEvent.keyDown(row, { key: 'a' });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Tab' });
    expect(onOpenEnvironments).not.toHaveBeenCalled();
    expect(row).toHaveAttribute('aria-selected', 'true');
  });

  it('clamps the highlight when the list shrinks underneath it', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CommandPalette open onOpenChange={onChange} onOpenEnvironments={() => {}} />
    );
    // "Manage environments" is the last row.
    fireEvent.mouseEnter(option(/manage environments/i));
    rerender(<CommandPalette open onOpenChange={onChange} />);
    const rows = screen.getAllByRole('option');
    expect(rows[rows.length - 1]).toHaveAttribute('aria-selected', 'true');
  });

  it('activates a row with Space from the row itself', () => {
    const onOpenEnvironments = vi.fn();
    renderControlled({ onOpenEnvironments });
    fireEvent.keyDown(option(/manage environments/i), { key: ' ' });
    expect(onOpenEnvironments).toHaveBeenCalledTimes(1);
  });
});
