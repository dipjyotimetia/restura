import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { JumpToLatestPill } from '@/components/shared/messageLog/MessageLogControls';
import { useStickToBottom } from '@/hooks/useStickToBottom';

function setGeometry(el: HTMLElement, { scrollHeight, clientHeight }: Record<string, number>) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
}

function List({ count }: { count: number }) {
  const { ref, onScroll, showJump, jumpToLatest } = useStickToBottom<HTMLDivElement>(count);
  return (
    <div>
      <div data-testid="list" ref={ref} onScroll={onScroll}>
        {Array.from({ length: count }, (_, i) => (
          <div key={i}>row {i}</div>
        ))}
      </div>
      <JumpToLatestPill visible={showJump} onClick={jumpToLatest} />
    </div>
  );
}

describe('useStickToBottom', () => {
  it('follows new rows while the user is at the bottom', () => {
    const { rerender } = render(<List count={1} />);
    const list = screen.getByTestId('list');
    setGeometry(list, { scrollHeight: 500, clientHeight: 100 });
    rerender(<List count={2} />);
    expect(list.scrollTop).toBe(500);
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();
  });

  it('stops following and offers a Jump to latest pill once scrolled up', () => {
    const { rerender } = render(<List count={1} />);
    const list = screen.getByTestId('list');
    setGeometry(list, { scrollHeight: 1000, clientHeight: 100 });
    list.scrollTop = 200;
    fireEvent.scroll(list);
    rerender(<List count={2} />);
    expect(list.scrollTop).toBe(200);
    const pill = screen.getByRole('button', { name: /jump to latest/i });
    act(() => pill.click());
    expect(list.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();
    // Back at the bottom: following resumes.
    setGeometry(list, { scrollHeight: 1200, clientHeight: 100 });
    rerender(<List count={3} />);
    expect(list.scrollTop).toBe(1200);
  });

  it('hides the pill when the user scrolls back to the bottom', () => {
    const { rerender } = render(<List count={1} />);
    const list = screen.getByTestId('list');
    setGeometry(list, { scrollHeight: 1000, clientHeight: 100 });
    list.scrollTop = 0;
    fireEvent.scroll(list);
    rerender(<List count={2} />);
    expect(screen.getByRole('button', { name: /jump to latest/i })).toBeInTheDocument();
    list.scrollTop = 900;
    fireEvent.scroll(list);
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();
  });
});
