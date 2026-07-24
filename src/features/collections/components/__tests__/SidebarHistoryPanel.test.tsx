import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import { SidebarHistoryPanel } from '../SidebarHistoryPanel';

describe('SidebarHistoryPanel', () => {
  it('keeps the method-filter contract in the extracted panel', () => {
    const onMethodFilterChange = vi.fn();

    render(
      <Tabs defaultValue="history">
        <SidebarHistoryPanel
          filteredHistory={[]}
          favorites={[]}
          hasMoreHistory={false}
          methodFilter="GET"
          searchQuery=""
          staggerInitial={false}
          totalHistoryCount={1}
          visibleHistoryCount={1}
          onLoadHistoryItem={vi.fn()}
          onLoadMore={vi.fn()}
          onMethodFilterChange={onMethodFilterChange}
          onToggleFavorite={vi.fn()}
        />
      </Tabs>
    );

    expect(screen.getByText('No matching requests')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'POST' }));
    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    expect(onMethodFilterChange).toHaveBeenNthCalledWith(1, 'POST');
    expect(onMethodFilterChange).toHaveBeenNthCalledWith(2, null);
  });
});
