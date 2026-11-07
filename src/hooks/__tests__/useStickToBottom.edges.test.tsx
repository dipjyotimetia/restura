import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useStickToBottom } from '@/hooks/useStickToBottom';

function setGeometry(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
}

function List({ count, threshold }: { count: number; threshold?: number }) {
  const { ref, onScroll, showJump } = useStickToBottom<HTMLDivElement>(count, threshold);
  return (
    <div>
      <div data-testid="list" ref={ref} onScroll={onScroll} />
      {showJump && <span>jump</span>}
    </div>
  );
}

describe('useStickToBottom edge cases', () => {
  it('is inert before the ref is attached', () => {
    const { result, rerender } = renderHook(({ count }) => useStickToBottom(count), {
      initialProps: { count: 0 },
    });
    act(() => {
      result.current.onScroll();
      result.current.jumpToLatest();
    });
    rerender({ count: 3 });
    expect(result.current.showJump).toBe(false);
  });

  it('resumes following after the log is cleared', () => {
    const { rerender } = render(<List count={2} />);
    const list = screen.getByTestId('list');
    setGeometry(list, 1000, 100);
    list.scrollTop = 0;
    fireEvent.scroll(list);
    rerender(<List count={3} />);
    expect(screen.getByText('jump')).toBeInTheDocument();
    rerender(<List count={0} />);
    expect(screen.queryByText('jump')).toBeNull();
    // Next rows follow again even though the user had scrolled up.
    setGeometry(list, 400, 100);
    rerender(<List count={1} />);
    expect(list.scrollTop).toBe(400);
  });

  it('does not show the pill when rows shrink without clearing', () => {
    const { rerender } = render(<List count={3} />);
    const list = screen.getByTestId('list');
    setGeometry(list, 1000, 100);
    list.scrollTop = 0;
    fireEvent.scroll(list);
    rerender(<List count={2} />);
    expect(screen.queryByText('jump')).toBeNull();
  });

  it('honours a custom threshold', () => {
    const { rerender } = render(<List count={1} threshold={200} />);
    const list = screen.getByTestId('list');
    setGeometry(list, 1000, 100);
    // 150px from the bottom: inside the 200px threshold, still following.
    list.scrollTop = 750;
    fireEvent.scroll(list);
    rerender(<List count={2} threshold={200} />);
    expect(list.scrollTop).toBe(1000);
    expect(screen.queryByText('jump')).toBeNull();
  });
});
