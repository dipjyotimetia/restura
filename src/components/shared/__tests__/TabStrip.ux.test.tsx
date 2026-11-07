import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { protocolRegistry } from '@/features/registry/registry';
import type { ProtocolModule } from '@/features/registry/types';
import { useRequestStore } from '@/store/useRequestStore';
import { TabStrip } from '../TabBar';

// A fake protocol whose connection lifecycle reports the tabs in `liveTabs` as live.
const liveTabs = new Set<string>();
if (!protocolRegistry.get('fake-live-tabstrip')) {
  protocolRegistry.register({
    id: 'fake-live-tabstrip',
    connectionLifecycle: {
      connectionIdForTab: () => undefined,
      disconnect: () => undefined,
      removeConnectionForTab: () => undefined,
      isLive: (tabId: string) => liveTabs.has(tabId),
    },
  } as unknown as ProtocolModule);
}

function resetStore() {
  useRequestStore.setState((s) => ({ ...s, tabs: [], activeTabId: null }));
}

function newTab(name: string): string {
  const id = useRequestStore.getState().createNewRequest('http');
  useRequestStore.getState().renameTab(id, name);
  // Renaming marks the tab dirty; these tests start from a clean tab.
  useRequestStore.getState().clearTabDirty(id);
  return id;
}

describe('TabStrip — live connections (A2)', () => {
  beforeEach(() => {
    resetStore();
    liveTabs.clear();
  });

  it('confirms before closing a clean tab with a live connection', async () => {
    const user = userEvent.setup();
    const id = newTab('Socket');
    liveTabs.add(id);
    render(<TabStrip />);

    await user.click(screen.getByRole('button', { name: /close Socket/i }));
    expect(useRequestStore.getState().tabs.map((t) => t.id)).toContain(id);
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/live connection/i);

    await user.click(screen.getByRole('button', { name: /disconnect & close/i }));
    expect(useRequestStore.getState().tabs.map((t) => t.id)).not.toContain(id);
  });

  it('closes a clean idle tab immediately', async () => {
    const user = userEvent.setup();
    const id = newTab('Idle');
    render(<TabStrip />);
    await user.click(screen.getByRole('button', { name: /close Idle/i }));
    expect(useRequestStore.getState().tabs.map((t) => t.id)).not.toContain(id);
  });

  it('mentions the live connection count on bulk close', async () => {
    const user = userEvent.setup();
    const a = newTab('A');
    const b = newTab('B');
    const c = newTab('C');
    liveTabs.add(b);
    liveTabs.add(c);
    render(<TabStrip />);

    fireEvent.contextMenu(screen.getByRole('tab', { name: /^A/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Close Others' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(/2 live connections/i);
    expect(useRequestStore.getState().tabs).toHaveLength(3);
    await user.click(within(dialog).getByRole('button', { name: /disconnect & close/i }));
    expect(useRequestStore.getState().tabs.map((t) => t.id)).toEqual([a]);
  });

  it('marks tabs with a live connection (dot + accessible name)', () => {
    const id = newTab('Stream');
    liveTabs.add(id);
    render(<TabStrip />);
    expect(screen.getByRole('tab', { name: 'Stream, live connection' })).toBeInTheDocument();
  });
});

describe('TabStrip — accessibility (A5)', () => {
  beforeEach(resetStore);

  it('includes unsaved changes in the tab accessible name', () => {
    const id = newTab('Dirty');
    useRequestStore.setState((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, isDirty: true } : t)),
    }));
    render(<TabStrip />);
    expect(screen.getByRole('tab', { name: 'Dirty, unsaved changes' })).toBeInTheDocument();
  });

  it('keeps tab close buttons out of the tab order (Delete closes the active tab)', () => {
    newTab('A');
    render(<TabStrip />);
    expect(screen.getByRole('button', { name: /close A/i })).toHaveAttribute('tabindex', '-1');
  });
});

describe('TabStrip — overflow (A4)', () => {
  const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');

  beforeEach(() => {
    resetStore();
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get: () => 2000,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 500,
    });
  });

  afterEach(() => {
    if (originalScrollWidth)
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth);
    if (originalClientWidth)
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
  });

  it('scrolls the strip horizontally on vertical wheel', () => {
    newTab('A');
    render(<TabStrip />);
    const strip = screen.getByRole('tablist');
    strip.scrollLeft = 0;
    fireEvent.wheel(strip, { deltaY: 120, deltaX: 0 });
    expect(strip.scrollLeft).toBe(120);
  });

  it('offers an all-tabs dropdown when overflowing that switches tabs', async () => {
    const user = userEvent.setup();
    const a = newTab('First');
    newTab('Second');
    render(<TabStrip />);
    await act(async () => {});

    await user.click(screen.getByRole('button', { name: /show all tabs/i }));
    await user.click(await screen.findByRole('menuitem', { name: /First/ }));
    expect(useRequestStore.getState().activeTabId).toBe(a);
  });
});
