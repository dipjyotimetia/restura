import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import type { HistoryItem } from '@/types';
import { SidebarHistoryPanel } from '../SidebarHistoryPanel';

function httpHistory(
  id: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  status?: number,
  resolvedUrl?: string
): HistoryItem {
  return {
    id,
    request: {
      id: `request-${id}`,
      type: 'http',
      name: id,
      method,
      url: `https://template.test/${id}`,
      headers: [],
      params: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    },
    ...(status === undefined
      ? {}
      : {
          response: {
            id: `response-${id}`,
            requestId: `request-${id}`,
            status,
            statusText: 'status',
            headers: {},
            body: '',
            size: 0,
            time: 1,
            timestamp: 0,
          },
        }),
    ...(resolvedUrl ? { resolvedUrl } : {}),
    timestamp: 0,
  };
}

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
    fireEvent.click(screen.getByRole('button', { name: 'GET' }));
    fireEvent.click(screen.getByRole('button', { name: 'POST' }));
    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    expect(onMethodFilterChange).toHaveBeenNthCalledWith(1, null);
    expect(onMethodFilterChange).toHaveBeenNthCalledWith(2, 'POST');
    expect(onMethodFilterChange).toHaveBeenNthCalledWith(3, null);
  });

  it('renders the unfiltered empty state without filter controls', () => {
    render(
      <Tabs defaultValue="history">
        <SidebarHistoryPanel
          filteredHistory={[]}
          favorites={[]}
          hasMoreHistory={false}
          methodFilter={null}
          searchQuery=""
          staggerInitial="hidden"
          totalHistoryCount={0}
          visibleHistoryCount={0}
          onLoadHistoryItem={vi.fn()}
          onLoadMore={vi.fn()}
          onMethodFilterChange={vi.fn()}
          onToggleFavorite={vi.fn()}
        />
      </Tabs>
    );

    expect(screen.getByText('No history yet')).toBeInTheDocument();
    expect(screen.getByText('Send a request to see it here')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'GET' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  it('renders protocol/status variants and keeps row, favorite, filter, and pagination actions distinct', () => {
    const onLoadHistoryItem = vi.fn();
    const onLoadMore = vi.fn();
    const onMethodFilterChange = vi.fn();
    const onToggleFavorite = vi.fn();
    const history: HistoryItem[] = [
      httpHistory('success', 'GET', 204, 'https://resolved.test/success'),
      httpHistory('redirect', 'POST', 302),
      httpHistory('failure', 'DELETE', 500),
      httpHistory('pending', 'PATCH'),
      {
        id: 'grpc',
        request: {
          id: 'request-grpc',
          type: 'grpc',
          name: 'grpc',
          methodType: 'unary',
          url: 'grpc://example.test',
          service: 'catalog.v1.Products',
          method: 'Get',
          metadata: [],
          message: '{}',
          auth: { type: 'none' },
        },
        response: {
          id: 'response-grpc',
          requestId: 'request-grpc',
          status: 0,
          statusText: 'OK',
          headers: {},
          body: '',
          size: 0,
          time: 1,
          timestamp: 0,
        },
        timestamp: 0,
      },
    ];

    render(
      <Tabs defaultValue="history">
        <SidebarHistoryPanel
          filteredHistory={history}
          favorites={['success']}
          hasMoreHistory
          methodFilter={null}
          searchQuery=""
          staggerInitial={false}
          totalHistoryCount={8}
          visibleHistoryCount={history.length}
          onLoadHistoryItem={onLoadHistoryItem}
          onLoadMore={onLoadMore}
          onMethodFilterChange={onMethodFilterChange}
          onToggleFavorite={onToggleFavorite}
        />
      </Tabs>
    );

    expect(screen.getByText('https://resolved.test/success')).toBeInTheDocument();
    expect(screen.getByText('https://template.test/redirect')).toBeInTheDocument();
    expect(screen.getByText('catalog.v1.Products')).toBeInTheDocument();
    expect(screen.getByText('204')).toBeInTheDocument();
    expect(screen.getByText('302')).toBeInTheDocument();
    expect(screen.getByText('500')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove from favorites' }));
    fireEvent.click(screen.getByText('https://template.test/redirect'));
    fireEvent.click(screen.getByRole('button', { name: 'GET' }));
    fireEvent.click(screen.getByRole('button', { name: 'POST' }));
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load More (3 remaining)' }));

    expect(onToggleFavorite).toHaveBeenCalledWith('success');
    expect(onLoadHistoryItem).toHaveBeenCalledWith('redirect');
    expect(onMethodFilterChange).toHaveBeenNthCalledWith(1, 'GET');
    expect(onMethodFilterChange).toHaveBeenNthCalledWith(2, 'POST');
    expect(onMethodFilterChange).toHaveBeenNthCalledWith(3, null);
    expect(onLoadMore).toHaveBeenCalledOnce();
  });
});
