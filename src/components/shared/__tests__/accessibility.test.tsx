import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import IconRail from '../IconRail';
import { TabBar } from '../TabBar';

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn(), resolvedTheme: 'light' }),
}));

vi.mock('@/store/useRequestStore', () => ({
  useRequestStore: (selector: (s: unknown) => unknown) => {
    const state = {
      tabs: [
        {
          id: 'tab-1',
          request: { id: 'req-1', name: 'GET Example', type: 'http' },
          isDirty: false,
        },
        {
          id: 'tab-2',
          request: { id: 'req-2', name: 'POST Data', type: 'http' },
          isDirty: false,
        },
      ],
      activeTabId: 'tab-1',
      switchTab: vi.fn(),
      closeTab: vi.fn(),
      closeOtherTabs: vi.fn(),
      closeAllTabs: vi.fn(),
      duplicateTab: vi.fn(),
      createNewRequest: vi.fn(),
      reorderTabs: vi.fn(),
      isLoading: false,
    };
    return selector(state);
  },
}));

describe('IconRail accessibility', () => {
  it('renders a nav landmark with label Primary', () => {
    render(
      <IconRail
        activePanel={null}
        onPanelChange={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    );
    expect(screen.getByRole('navigation', { name: /primary/i })).toBeInTheDocument();
  });

  it('nav items have accessible labels', () => {
    render(
      <IconRail
        activePanel={null}
        onPanelChange={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /collections/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /history/i })).toBeInTheDocument();
  });
});

describe('TabBar accessibility', () => {
  it('renders a tablist', () => {
    render(<TabBar />);
    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });

  it('each tab has role="tab" and aria-selected', () => {
    render(<TabBar />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBeGreaterThan(0);
    const activeTab = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
    expect(activeTab).toBeTruthy();
  });

  it('active tab is focusable (tabIndex=0), inactive tabs have tabIndex=-1', () => {
    render(<TabBar />);
    const tabs = screen.getAllByRole('tab');
    const active = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
    const inactive = tabs.filter((t) => t.getAttribute('aria-selected') === 'false');
    expect(active?.tabIndex).toBe(0);
    inactive.forEach((t) => expect(t.tabIndex).toBe(-1));
  });
});
