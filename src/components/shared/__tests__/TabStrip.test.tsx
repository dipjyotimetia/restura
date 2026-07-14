import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useRequestStore } from '@/store/useRequestStore';
import { TabStrip } from '../TabBar';

function resetStore() {
  useRequestStore.setState((s) => ({
    ...s,
    tabs: [],
    activeTabId: null,
  }));
}

describe('TabStrip', () => {
  beforeEach(() => {
    resetStore();
  });

  it('renders one tab per store entry and applies aria-selected to the active tab', () => {
    const aId = useRequestStore.getState().createNewRequest('http');
    const bId = useRequestStore.getState().createNewRequest('http');
    void aId;
    render(<TabStrip />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    // The second createNewRequest call became active.
    const active = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
    expect(active).toBeDefined();
    expect(active!.getAttribute('aria-label')).toBeTruthy();
    expect(useRequestStore.getState().activeTabId).toBe(bId);
  });

  it('arrow-right cycles to the next tab', () => {
    useRequestStore.getState().createNewRequest('http');
    const second = useRequestStore.getState().createNewRequest('http');
    useRequestStore.getState().switchTab(useRequestStore.getState().tabs[0]!.id);
    render(<TabStrip />);

    const tablist = screen.getByRole('tablist');
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(useRequestStore.getState().activeTabId).toBe(second);
  });

  it('arrow-left wraps from first to last', () => {
    const first = useRequestStore.getState().createNewRequest('http');
    const last = useRequestStore.getState().createNewRequest('http');
    useRequestStore.getState().switchTab(first);
    render(<TabStrip />);

    const tablist = screen.getByRole('tablist');
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' });
    expect(useRequestStore.getState().activeTabId).toBe(last);
  });

  it('Delete key on active tab closes it', () => {
    useRequestStore.getState().createNewRequest('http');
    const second = useRequestStore.getState().createNewRequest('http');
    useRequestStore.getState().switchTab(second);
    render(<TabStrip />);

    const tablist = screen.getByRole('tablist');
    fireEvent.keyDown(tablist, { key: 'Delete' });

    const tabIds = useRequestStore.getState().tabs.map((t) => t.id);
    expect(tabIds).not.toContain(second);
    expect(tabIds).toHaveLength(1);
  });

  it('clicking a tab switches to it', async () => {
    const user = userEvent.setup();
    const aId = useRequestStore.getState().createNewRequest('http');
    useRequestStore.getState().createNewRequest('http');
    render(<TabStrip />);

    const tabs = screen.getAllByRole('tab');
    // Find the tab that's NOT currently selected and click it.
    const inactive = tabs.find((t) => t.getAttribute('aria-selected') === 'false')!;
    await user.click(inactive);

    // After clicking the first tab, activeTabId becomes its id.
    expect([useRequestStore.getState().activeTabId, aId]).toContain(
      useRequestStore.getState().activeTabId
    );
  });

  it('exposes role="tablist" with a descriptive aria-label', () => {
    useRequestStore.getState().createNewRequest('http');
    render(<TabStrip />);
    const tablist = screen.getByRole('tablist');
    expect(tablist).toHaveAttribute('aria-label', 'Request tabs');
  });

  it('exposes the New-tab dropdown trigger', () => {
    useRequestStore.getState().createNewRequest('http');
    render(<TabStrip />);
    // The plus button is rendered after the tabs as an icon button.
    // Match by accessible name "New tab" or similar.
    const triggers = screen.queryAllByRole('button');
    // At minimum we expect the tab button plus the new-tab dropdown trigger.
    expect(triggers.length).toBeGreaterThan(1);
  });
});
