import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useRequestStore } from '@/store/useRequestStore';
import type { HttpRequest } from '@/types';
import { TabBar } from './TabBar';

const makeHttp = (overrides: Partial<HttpRequest> = {}): HttpRequest => ({
  id: 'r-' + Math.random().toString(36).slice(2),
  name: 'Test',
  type: 'http',
  method: 'GET',
  url: 'https://example.com/',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
  ...overrides,
});

describe('TabBar', () => {
  beforeEach(() => {
    useRequestStore.setState({ tabs: [], activeTabId: null, isLoading: false });
  });

  it('renders the new-tab button when no tabs are open', () => {
    render(<TabBar />);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByRole('button', { name: /new request/i })).toBeInTheDocument();
  });

  it('renders one button per open tab with the request name', () => {
    useRequestStore.getState().openTab(makeHttp({ name: 'Get user' }));
    render(<TabBar />);
    expect(screen.getByRole('tab', { name: /Get user/ })).toBeInTheDocument();
  });

  it('marks the active tab with aria-selected', () => {
    const a = useRequestStore.getState().openTab(makeHttp({ name: 'A' }));
    useRequestStore.getState().openTab(makeHttp({ name: 'B' }));
    // The newly opened tab is now active; switch back to A
    useRequestStore.getState().switchTab(a);
    render(<TabBar />);
    const tabA = screen.getByRole('tab', { name: /A/ });
    const tabB = screen.getByRole('tab', { name: /B/ });
    expect(tabA).toHaveAttribute('aria-selected', 'true');
    expect(tabB).toHaveAttribute('aria-selected', 'false');
  });

  it('clicking a tab switches active', () => {
    const a = useRequestStore.getState().openTab(makeHttp({ name: 'A' }));
    useRequestStore.getState().openTab(makeHttp({ name: 'B' }));
    render(<TabBar />);
    fireEvent.click(screen.getByRole('tab', { name: /A/ }));
    expect(useRequestStore.getState().activeTabId).toBe(a);
  });

  it('clicking the close button on a tab closes it', () => {
    useRequestStore.getState().openTab(makeHttp({ name: 'A' }));
    render(<TabBar />);
    const closeBtn = screen.getByRole('button', { name: /close A/i });
    fireEvent.click(closeBtn);
    expect(useRequestStore.getState().tabs).toHaveLength(0);
  });

  it('shows a dirty indicator when isDirty is true', () => {
    useRequestStore.getState().openTab(makeHttp({ name: 'A' }));
    useRequestStore.getState().setDirty(true);
    render(<TabBar />);
    expect(screen.getByLabelText(/unsaved changes/i)).toBeInTheDocument();
  });

  it('does not show a dirty indicator when isDirty is false', () => {
    useRequestStore.getState().openTab(makeHttp({ name: 'A' }));
    render(<TabBar />);
    expect(screen.queryByLabelText(/unsaved changes/i)).not.toBeInTheDocument();
  });

  it('drag-reorders tabs via native DnD', () => {
    const a = useRequestStore.getState().openTab(makeHttp({ name: 'A' }));
    const b = useRequestStore.getState().openTab(makeHttp({ name: 'B' }));
    const c = useRequestStore.getState().openTab(makeHttp({ name: 'C' }));
    render(<TabBar />);

    const tabA = screen.getByRole('tab', { name: /A/ });
    const tabC = screen.getByRole('tab', { name: /C/ });

    // Drag A onto C → expected order: B, C-with-A-before-it (A inserted at C's position)
    fireEvent.dragStart(tabA);
    fireEvent.dragOver(tabC);
    fireEvent.drop(tabC);
    fireEvent.dragEnd(tabA);

    const order = useRequestStore.getState().tabs.map((t) => t.id);
    // A moved from position 0 to position 2 (where C was); result: [B, A, C] OR [B, C, A]
    // depending on how the drop is interpreted. The contract: A is now at the position
    // where C was, so the resulting order should be [B, C, A] (A inserted AFTER C is wrong;
    // standard convention: A inserted AT C's index, pushing C to the right) OR equivalently
    // [B, A, C]. Pick one and stick with it.
    expect(order).toEqual([b, c, a]);
  });
});
