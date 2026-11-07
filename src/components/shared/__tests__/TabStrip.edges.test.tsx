import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { protocolRegistry } from '@/features/registry/registry';
import type { ProtocolModule } from '@/features/registry/types';
import { useRequestStore } from '@/store/useRequestStore';
import type { RequestTab } from '@/types';
import { TabStrip } from '../TabBar';

const saveBack = vi.hoisted(() => ({ saveTabBackToCollection: vi.fn() }));
vi.mock('@/features/collections/lib/saveBack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/collections/lib/saveBack')>()),
  saveTabBackToCollection: saveBack.saveTabBackToCollection,
}));

/** Opens an HTTP tab and patches it (name/url/flags) without marking it dirty. */
function openTab(patch: Partial<RequestTab> & { name?: string; url?: string } = {}): string {
  const id = useRequestStore.getState().createNewRequest('http');
  const { name, url, ...tabPatch } = patch;
  useRequestStore.setState((s) => ({
    tabs: s.tabs.map((t) =>
      t.id === id
        ? {
            ...t,
            ...tabPatch,
            request: {
              ...t.request,
              ...(name !== undefined && { name }),
              ...(url !== undefined && { url }),
            } as RequestTab['request'],
          }
        : t
    ),
  }));
  return id;
}

function tabNames() {
  return screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label'));
}

function storeNames() {
  return useRequestStore.getState().tabs.map((t) => t.request.name);
}

beforeEach(() => {
  saveBack.saveTabBackToCollection.mockReset();
  useRequestStore.setState((s) => ({ ...s, tabs: [], activeTabId: null }));
});

describe('TabStrip display names', () => {
  it('derives titles from the mode, the edited URL, or the raw name', () => {
    openTab({ modeOverride: 'websocket' });
    openTab({ url: 'https://api.example.com/users' });
    openTab({ url: 'https://api.example.com/' });
    openTab({ url: '{{base}}/orders' });
    openTab({ name: '   ' });
    openTab({ name: 'My call', url: 'https://ignored.example.com/x' });
    render(<TabStrip />);
    expect(tabNames()).toEqual([
      'New WebSocket Request',
      'api.example.com/users',
      'api.example.com',
      '{{base}}/orders',
      'New Request',
      'My call',
    ]);
  });
});

describe('TabStrip rename', () => {
  it('renames on double-click + Enter, and ignores Escape or a blank name', async () => {
    const user = userEvent.setup();
    openTab({ name: 'Orders' });
    render(<TabStrip />);

    await user.dblClick(screen.getByTitle('Orders'));
    let input = screen.getByRole('textbox', { name: 'Rename request' });
    await user.clear(input);
    await user.type(input, 'Invoices{Enter}');
    expect(storeNames()).toEqual(['Invoices']);

    await user.dblClick(screen.getByTitle('Invoices'));
    input = screen.getByRole('textbox', { name: 'Rename request' });
    await user.type(input, ' extra{Escape}');
    expect(storeNames()).toEqual(['Invoices']);
    expect(screen.queryByRole('textbox', { name: 'Rename request' })).toBeNull();

    await user.dblClick(screen.getByTitle('Invoices'));
    input = screen.getByRole('textbox', { name: 'Rename request' });
    await user.clear(input);
    fireEvent.blur(input);
    expect(storeNames()).toEqual(['Invoices']);
  });

  it('renames from the context menu', async () => {
    const user = userEvent.setup();
    openTab({ name: 'Orders' });
    render(<TabStrip />);
    fireEvent.contextMenu(screen.getByRole('tab'));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const input = await screen.findByRole('textbox', { name: 'Rename request' });
    expect(input).toHaveValue('Orders');
    await user.clear(input);
    await user.type(input, 'Renamed');
    fireEvent.blur(input);
    expect(storeNames()).toEqual(['Renamed']);
  });
});

describe('TabStrip save-changes dot', () => {
  it('writes a bound dirty tab back and clears its dirty flag', async () => {
    const user = userEvent.setup();
    saveBack.saveTabBackToCollection.mockReturnValue(true);
    const id = openTab({ name: 'Bound', isDirty: true, savedRequestId: 'saved-1' });
    render(<TabStrip />);
    await user.click(screen.getByRole('button', { name: 'Save changes to collection' }));
    expect(saveBack.saveTabBackToCollection).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Bound' }),
      'saved-1',
      expect.objectContaining({ id })
    );
    expect(useRequestStore.getState().tabs[0]?.isDirty).toBe(false);
  });

  it('keeps the tab dirty when the write-back fails', async () => {
    const user = userEvent.setup();
    saveBack.saveTabBackToCollection.mockReturnValue(false);
    openTab({ name: 'Bound', isDirty: true, savedRequestId: 'saved-1' });
    render(<TabStrip />);
    await user.click(screen.getByRole('button', { name: 'Save changes to collection' }));
    expect(useRequestStore.getState().tabs[0]?.isDirty).toBe(true);
  });
});

const liveTabs = new Set<string>();
if (!protocolRegistry.get('fake-live-tabstrip-edges')) {
  protocolRegistry.register({
    id: 'fake-live-tabstrip-edges',
    connectionLifecycle: {
      connectionIdForTab: () => undefined,
      disconnect: () => undefined,
      removeConnectionForTab: () => undefined,
      isLive: (tabId: string) => liveTabs.has(tabId),
    },
  } as unknown as ProtocolModule);
}

describe('TabStrip context menu', () => {
  beforeEach(() => liveTabs.clear());

  it('duplicates and closes a tab', async () => {
    const user = userEvent.setup();
    openTab({ name: 'Orders' });
    render(<TabStrip />);
    fireEvent.contextMenu(screen.getByRole('tab'));
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    expect(useRequestStore.getState().tabs).toHaveLength(2);

    fireEvent.contextMenu(screen.getAllByRole('tab')[0]!);
    await user.click(await screen.findByRole('menuitem', { name: 'Close' }));
    expect(useRequestStore.getState().tabs).toHaveLength(1);
  });

  it('pluralises Close All over several dirty tabs plus a live one; Keep open backs out', async () => {
    const user = userEvent.setup();
    openTab({ name: 'One', isDirty: true });
    openTab({ name: 'Two', isDirty: true });
    const live = openTab({ name: 'Live' });
    liveTabs.add(live);
    render(<TabStrip />);
    fireEvent.contextMenu(screen.getAllByRole('tab')[0]!);
    await user.click(await screen.findByRole('menuitem', { name: 'Close All' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Discard unsaved changes in 2 tabs?');
    expect(dialog).toHaveTextContent('1 live connection will be disconnected.');
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual(['One', 'Two']);
    await user.click(within(dialog).getByRole('button', { name: 'Keep open' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(useRequestStore.getState().tabs).toHaveLength(3);
  });

  it('counts several live connections when closing clean live tabs', async () => {
    const user = userEvent.setup();
    const a = openTab({ name: 'A' });
    const b = openTab({ name: 'B' });
    liveTabs.add(a);
    liveTabs.add(b);
    render(<TabStrip />);
    fireEvent.contextMenu(screen.getAllByRole('tab')[0]!);
    await user.click(await screen.findByRole('menuitem', { name: 'Close All' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Close 2 tabs?');
    expect(dialog).toHaveTextContent('2 live connections will be disconnected.');
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect & close' }));
    expect(useRequestStore.getState().tabs).toHaveLength(0);
  });

  it('opens the built-in save dialog without an onSaveToCollection handler', async () => {
    const user = userEvent.setup();
    openTab({ name: 'Orders' });
    render(<TabStrip />);
    fireEvent.contextMenu(screen.getByRole('tab'));
    await user.click(await screen.findByRole('menuitem', { name: /save to collection/i }));
    expect(await screen.findByRole('dialog', { name: 'Save to Collection' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Save to Collection' })).toBeNull();
  });
});

describe('TabStrip keyboard with no tabs', () => {
  it('treats arrow keys and Delete as no-ops on an empty strip', () => {
    render(<TabStrip />);
    const strip = screen.getByRole('tablist');
    fireEvent.keyDown(strip, { key: 'ArrowRight' });
    fireEvent.keyDown(strip, { key: 'ArrowLeft' });
    fireEvent.keyDown(strip, { key: 'Delete' });
    expect(useRequestStore.getState().tabs).toEqual([]);
    expect(useRequestStore.getState().activeTabId).toBeNull();
  });
});

describe('TabStrip wheel + drag edge cases', () => {
  it('leaves horizontal wheels and non-overflowing strips alone', () => {
    openTab({ name: 'A' });
    render(<TabStrip />);
    const strip = screen.getByRole('tablist');
    strip.scrollLeft = 0;
    fireEvent.wheel(strip, { deltaY: 10, deltaX: 50 });
    expect(strip.scrollLeft).toBe(0);
    Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: 100 });
    Object.defineProperty(strip, 'clientWidth', { configurable: true, value: 100 });
    fireEvent.wheel(strip, { deltaY: 120, deltaX: 0 });
    expect(strip.scrollLeft).toBe(0);
  });

  it('ignores a drop onto the dragged tab itself and a drop after the drag ended', () => {
    const a = openTab({ name: 'A' });
    const b = openTab({ name: 'B' });
    render(<TabStrip />);
    const [tabA, tabB] = screen.getAllByRole('tab');
    fireEvent.dragStart(tabA!);
    fireEvent.dragOver(tabA!);
    fireEvent.drop(tabA!);
    expect(useRequestStore.getState().tabs.map((t) => t.id)).toEqual([a, b]);
    fireEvent.dragEnd(tabA!);
    fireEvent.drop(tabB!);
    expect(useRequestStore.getState().tabs.map((t) => t.id)).toEqual([a, b]);
  });

  it('ignores a drop when the dragged tab closed mid-drag', () => {
    const a = openTab({ name: 'A' });
    const b = openTab({ name: 'B' });
    const c = openTab({ name: 'C' });
    render(<TabStrip />);
    fireEvent.dragStart(screen.getByRole('tab', { name: 'A' }));
    useRequestStore.setState((s) => ({ tabs: s.tabs.filter((t) => t.id !== a) }));
    fireEvent.drop(screen.getByRole('tab', { name: 'C' }));
    expect(useRequestStore.getState().tabs.map((t) => t.id)).toEqual([b, c]);
  });
});
