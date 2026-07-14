import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WindowedList } from '../windowedList';

describe('WindowedList', () => {
  it('renders only items in the visible window plus overscan', () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ id: i, label: `Item ${i}` }));
    render(
      <WindowedList
        items={items}
        itemHeight={20}
        height={200}
        overscan={2}
        renderItem={(item) => (
          <div key={item.id} data-testid={`item-${item.id}`}>
            {item.label}
          </div>
        )}
      />
    );
    // 200/20 = 10 visible; +2 overscan top + 2 bottom = 14 max
    // At scroll=0, top is 0 so no overscan above; below: 10 visible + 2 = 12
    const rendered = screen.queryAllByText(/^Item /);
    expect(rendered.length).toBeLessThanOrEqual(14);
    expect(rendered.length).toBeGreaterThanOrEqual(10);
    // Item 0 should be present
    expect(screen.getByTestId('item-0')).toBeInTheDocument();
    // Item 999 should NOT be present
    expect(screen.queryByTestId('item-999')).toBeNull();
  });

  it('exposes scrollToBottom via ref', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const ref = {
      current: null as { scrollToBottom: () => void; isAtBottom: () => boolean } | null,
    };
    render(
      <WindowedList
        ref={ref}
        items={items}
        itemHeight={20}
        height={200}
        renderItem={(item) => (
          <div key={item.id} data-testid={`item-${item.id}`}>
            {item.id}
          </div>
        )}
      />
    );
    expect(ref.current).toBeTruthy();
    expect(typeof ref.current?.scrollToBottom).toBe('function');
    expect(typeof ref.current?.isAtBottom).toBe('function');
  });

  it('calls onScroll when user scrolls', () => {
    const onScroll = vi.fn();
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const { container } = render(
      <WindowedList
        items={items}
        itemHeight={20}
        height={200}
        onScroll={onScroll}
        renderItem={(item) => <div key={item.id}>{item.id}</div>}
      />
    );
    const scrollable = container.querySelector('[data-windowedlist-viewport]');
    expect(scrollable).toBeTruthy();
    fireEvent.scroll(scrollable!, { target: { scrollTop: 500 } });
    expect(onScroll).toHaveBeenCalledWith(500);
  });

  it('renders nothing when items is empty', () => {
    render(
      <WindowedList
        items={[]}
        itemHeight={20}
        height={200}
        renderItem={(item: { id: number }) => <div key={item.id}>{item.id}</div>}
      />
    );
    // Empty state is fine; just ensure no error and no rendered items
    expect(screen.queryByText(/^[0-9]+$/)).toBeNull();
  });
});
