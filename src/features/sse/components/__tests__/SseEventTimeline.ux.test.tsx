import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SseLogEntry } from '@/features/sse/store/useSseStore';
import SseEventTimeline from '../SseEventTimeline';

const entry = (i: number): SseLogEntry => ({
  kind: 'event',
  id: `e${i}`,
  event: 'message',
  data: `payload ${i}`,
  timestamp: i,
});

function renderTimeline(log: SseLogEntry[], droppedCount?: number) {
  return render(
    <SseEventTimeline
      log={log}
      searchQuery=""
      onSearchChange={vi.fn()}
      eventNameFilter="all"
      onEventNameFilterChange={vi.fn()}
      eventNames={[]}
      onClearLog={vi.fn()}
      {...(droppedCount !== undefined ? { droppedCount } : {})}
    />
  );
}

describe('SseEventTimeline UX', () => {
  it('disables Clear on an empty log (S12)', () => {
    renderTimeline([]);
    expect(screen.getByRole('button', { name: 'Clear log' })).toBeDisabled();
  });

  it('exposes the timeline as a log and reports cap drops (S8, S9)', () => {
    renderTimeline([entry(1)], 7);
    expect(screen.getByRole('log', { name: 'SSE events' })).toBeTruthy();
    expect(screen.getByText('Showing last 1,000 — 7 older dropped')).toBeTruthy();
  });

  it('does not yank the view to the bottom once the user scrolled up (S6)', () => {
    const { rerender } = renderTimeline([entry(1)]);
    const log = screen.getByRole('log', { name: 'SSE events' });
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 100 });
    log.scrollTop = 100;
    fireEvent.scroll(log);
    rerender(
      <SseEventTimeline
        log={[entry(1), entry(2)]}
        searchQuery=""
        onSearchChange={vi.fn()}
        eventNameFilter="all"
        onEventNameFilterChange={vi.fn()}
        eventNames={[]}
        onClearLog={vi.fn()}
      />
    );
    expect(log.scrollTop).toBe(100);
    expect(screen.getByRole('button', { name: /Jump to latest/ })).toBeTruthy();
  });
});
