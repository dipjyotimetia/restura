import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { HttpStreamEvent } from '@/features/http/lib/streamingResponseReader';
import { StreamingResponseViewer } from '../StreamingResponseViewer';

void vi;

async function* makeIterable(events: HttpStreamEvent[]): AsyncIterable<HttpStreamEvent> {
  for (const e of events) {
    await Promise.resolve();
    yield e;
  }
}

describe('StreamingResponseViewer', () => {
  it('renders incoming SSE events', async () => {
    const events: HttpStreamEvent[] = [
      { type: 'sse', payload: { data: 'hello' } },
      { type: 'sse', payload: { data: 'world', event: 'greeting' } },
      { type: 'end', bytesRead: 11, durationMs: 5 },
    ];
    render(<StreamingResponseViewer events={makeIterable(events)} />);
    await waitFor(() => {
      expect(screen.getByText('hello')).toBeInTheDocument();
      expect(screen.getByText('world')).toBeInTheDocument();
    });
  });

  it('renders ndjson values with one-line JSON preview', async () => {
    const events: HttpStreamEvent[] = [
      { type: 'ndjson', payload: { a: 1, b: 'x' } },
      { type: 'ndjson', payload: [1, 2, 3] },
      { type: 'end', bytesRead: 0, durationMs: 0 },
    ];
    render(<StreamingResponseViewer events={makeIterable(events)} />);
    await waitFor(() => {
      // The viewer renders compact JSON; assert the first event's serialised form is visible
      expect(screen.getByText(/"a":1/)).toBeInTheDocument();
      expect(screen.getByText(/\[1,2,3\]/)).toBeInTheDocument();
    });
  });

  it('shows "Stream ended" footer when end event arrives', async () => {
    const events: HttpStreamEvent[] = [
      { type: 'sse', payload: { data: 'a' } },
      { type: 'end', bytesRead: 1, durationMs: 1 },
    ];
    render(<StreamingResponseViewer events={makeIterable(events)} />);
    await waitFor(() => {
      expect(screen.getByText(/stream ended/i)).toBeInTheDocument();
    });
  });

  it('shows error row when error event arrives', async () => {
    const events: HttpStreamEvent[] = [
      { type: 'sse', payload: { data: 'a' } },
      { type: 'error', error: 'upstream gone', bytesRead: 1 },
    ];
    render(<StreamingResponseViewer events={makeIterable(events)} />);
    await waitFor(() => {
      expect(screen.getByText(/upstream gone/i)).toBeInTheDocument();
    });
  });

  it('pause stops rendering new events', async () => {
    let resolve!: () => void;
    const blocker = new Promise<void>((r) => {
      resolve = r;
    });
    async function* gated(): AsyncIterable<HttpStreamEvent> {
      yield { type: 'sse', payload: { data: 'first' } };
      await blocker;
      yield { type: 'sse', payload: { data: 'second' } };
      yield { type: 'end', bytesRead: 11, durationMs: 1 };
    }
    const user = userEvent.setup();
    render(<StreamingResponseViewer events={gated()} />);
    await waitFor(() => expect(screen.getByText('first')).toBeInTheDocument());

    const pauseBtn = screen.getByRole('button', { name: /pause/i });
    await user.click(pauseBtn);

    // Release the blocker so the iterable produces 'second'
    await act(async () => {
      resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // 'second' should NOT yet be rendered while paused (it's buffered)
    expect(screen.queryByText('second')).toBeNull();

    // Resume should drain
    const resumeBtn = screen.getByRole('button', { name: /resume/i });
    await user.click(resumeBtn);
    await waitFor(() => expect(screen.getByText('second')).toBeInTheDocument());
  });

  it('shows event count and bytes read in the header bar', async () => {
    const events: HttpStreamEvent[] = [
      { type: 'sse', payload: { data: 'a' } },
      { type: 'sse', payload: { data: 'b' } },
      { type: 'end', bytesRead: 42, durationMs: 100 },
    ];
    render(<StreamingResponseViewer events={makeIterable(events)} />);
    await waitFor(() => {
      // 2 events (the 'end' is metadata, not an event)
      expect(screen.getByText(/2 events/i)).toBeInTheDocument();
      expect(screen.getByText(/42 bytes/i)).toBeInTheDocument();
    });
  });

  it('drops oldest events past maxRetained', async () => {
    const events: HttpStreamEvent[] = [];
    for (let i = 0; i < 50; i++) {
      events.push({ type: 'sse', payload: { data: `e${i}` } });
    }
    events.push({ type: 'end', bytesRead: 0, durationMs: 0 });
    render(<StreamingResponseViewer events={makeIterable(events)} maxRetained={10} />);
    await waitFor(() => {
      // The header should still show 50 received total, but only ~10 in the windowed list
      expect(screen.getByText(/50 events/i)).toBeInTheDocument();
    });
    // Oldest events are dropped — e0 should not be visible
    expect(screen.queryByText('e0')).toBeNull();
    // Most recent should be visible
    expect(screen.getByText('e49')).toBeInTheDocument();
  });
});
