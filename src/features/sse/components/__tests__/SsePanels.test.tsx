import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SseLogEntry } from '@/features/sse/store/useSseStore';
import SseAssembledOutput, { type SsePhase } from '../SseAssembledOutput';
import { SseCounters } from '../SseCounters';
import { SseEventTimeline } from '../SseEventTimeline';
import SseStatsRow from '../SseStatsRow';

describe('SseAssembledOutput', () => {
  const base = {
    text: '',
    progress: null,
    phases: [] as SsePhase[],
    isStreaming: false,
  };

  it('shows the waiting placeholder, indeterminate progress and no phases when idle', () => {
    render(<SseAssembledOutput {...base} />);
    expect(screen.getByText('Waiting for tokens…')).toBeInTheDocument();
    expect(screen.getByText('0 chars')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('Phases')).not.toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: 'Stream progress' });
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('0%');
  });

  it('pulses an indeterminate bar while streaming', () => {
    render(<SseAssembledOutput {...base} isStreaming />);
    const fill = screen.getByRole('progressbar').firstElementChild as HTMLElement;
    expect(fill.style.width).toBe('40%');
    expect(fill.className).toContain('animate-pulse');
  });

  it('renders text with a cursor while streaming and clamps progress', () => {
    const { container, rerender } = render(
      <SseAssembledOutput {...base} text="hello" progress={1.5} isStreaming />
    );
    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(container.querySelector('[aria-hidden="true"][style*="blink"]')).not.toBeNull();
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');

    rerender(<SseAssembledOutput {...base} text="hello" progress={-2} />);
    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(container.querySelector('[style*="blink"]')).toBeNull();

    rerender(<SseAssembledOutput {...base} text="hello" progress={0.42} />);
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('renders each phase state', () => {
    render(
      <SseAssembledOutput
        {...base}
        phases={[
          { id: 'a', label: 'Planning', state: 'done' },
          { id: 'b', label: 'Writing', state: 'active' },
          { id: 'c', label: 'Review', state: 'pending' },
        ]}
      />
    );
    expect(screen.getByText('Phases')).toBeInTheDocument();
    expect(screen.getByText('Planning').className).toContain('text-sp-muted');
    expect(screen.getByText('Writing').className).toContain('text-sp-text');
    expect(screen.getByText('Review').className).toContain('text-sp-dim');
  });
});

describe('SseStatsRow', () => {
  const base = { events: 1234, lastEventId: undefined, avgGapMs: null, reconnects: 2 } as const;

  it.each([
    ['connected', 'STREAMING'],
    ['connecting', 'CONNECTING'],
    ['reconnecting', 'RECONNECTING'],
    ['disconnected', 'IDLE'],
  ] as const)('labels the %s status as %s', (status, label) => {
    render(<SseStatsRow {...base} status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('shows placeholders when there is no id or gap', () => {
    render(<SseStatsRow {...base} status="connected" />);
    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.getByText('1,234')).toBeInTheDocument();
  });

  it('shows the last event id and rounded average gap', () => {
    render(<SseStatsRow {...base} status="connected" lastEventId="evt-9" avgGapMs={12.6} />);
    expect(screen.getByText('evt-9')).toBeInTheDocument();
    expect(screen.getByText('13ms')).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });
});

describe('SseCounters', () => {
  it.each([
    [512, '512 B'],
    [2048, '2.0 KB'],
    [3 * 1024 * 1024, '3.00 MB'],
  ])('formats %i bytes as %s', (bytes, text) => {
    render(<SseCounters events={1} bytes={bytes} tokens={2} reconnects={3} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});

describe('SseEventTimeline', () => {
  const entries: SseLogEntry[] = [
    { kind: 'system', id: 's1', message: 'Connected', timestamp: 1_700_000_000_000 },
    { kind: 'event', id: 'e1', event: 'token', data: 'hi', lastEventId: '7', timestamp: 1 },
    { kind: 'event', id: 'e2', event: 'custom', data: 'yo', timestamp: 2 },
  ];

  function renderTimeline(
    log: SseLogEntry[],
    over: Partial<Parameters<typeof SseEventTimeline>[0]> = {}
  ) {
    const props = {
      log,
      searchQuery: '',
      onSearchChange: vi.fn(),
      eventNameFilter: 'all',
      onEventNameFilterChange: vi.fn(),
      eventNames: ['token', 'custom'],
      onClearLog: vi.fn(),
      ...over,
    };
    render(<SseEventTimeline {...props} />);
    return props;
  }

  it('shows the empty state', () => {
    renderTimeline([]);
    expect(screen.getByText(/No events yet/)).toBeInTheDocument();
  });

  it('renders system rows and event rows with and without an id', () => {
    renderTimeline(entries);
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('id=7')).toBeInTheDocument();
    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByText('yo')).toBeInTheDocument();
    expect(screen.getAllByText(/^id=/)).toHaveLength(1);
  });

  it('wires search, filter and clear controls', () => {
    const props = renderTimeline(entries);
    fireEvent.change(screen.getByLabelText('Search events'), { target: { value: 'q' } });
    expect(props.onSearchChange).toHaveBeenCalledWith('q');
    fireEvent.change(screen.getByLabelText('Filter by event name'), { target: { value: 'token' } });
    expect(props.onEventNameFilterChange).toHaveBeenCalledWith('token');
    fireEvent.click(screen.getByLabelText('Clear log'));
    expect(props.onClearLog).toHaveBeenCalledOnce();
  });
});
