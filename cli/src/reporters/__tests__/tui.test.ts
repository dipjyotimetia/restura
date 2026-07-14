import { describe, expect, it } from 'vitest';
import { renderFrame, type TuiRow, type TuiState } from '../tui';

// Strip SGR colour codes so width assertions hold whether or not colour is on.
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const stripAnsi = (s: string): string => s.replace(ANSI, '');

const row = (name: string, outcome: TuiRow['outcome'], status = 200, durationMs = 41): TuiRow => ({
  method: 'GET',
  name,
  outcome,
  status,
  durationMs,
});

const state = (over: Partial<TuiState> = {}): TuiState => ({
  collectionName: 'My API',
  total: 3,
  rows: [],
  spinnerFrame: 0,
  done: false,
  ...over,
});

/** Visible width of every line, ANSI stripped. */
function widths(frame: string): number[] {
  return stripAnsi(frame)
    .split('\n')
    .map((l) => [...l].length);
}

describe('renderFrame', () => {
  it('draws an aligned box exactly `width` columns wide on every line', () => {
    const frame = renderFrame(
      state({ rows: [row('list users', 'pass'), row('create user', 'fail', 500)] }),
      { width: 50, maxRows: 10 }
    );
    for (const w of widths(frame)) expect(w).toBe(50);
    // top + 2 rows + mid + progress + bottom
    expect(frame.split('\n')).toHaveLength(6);
  });

  it('shows the collection name and request names', () => {
    const frame = stripAnsi(
      renderFrame(state({ rows: [row('list users', 'pass')] }), { width: 50, maxRows: 10 })
    );
    expect(frame).toContain('My API');
    expect(frame).toContain('list users');
    expect(frame).toContain('200');
  });

  it('renders a progress bar with percentage when total is known', () => {
    const frame = stripAnsi(
      renderFrame(state({ total: 4, rows: [row('a', 'pass'), row('b', 'pass')] }), {
        width: 60,
        maxRows: 10,
      })
    );
    expect(frame).toContain('2/4');
    expect(frame).toContain('50%');
    expect(frame).toContain('█'); // filled portion
    expect(frame).toContain('░'); // empty portion
  });

  it('omits the bar but keeps counts when total is unknown', () => {
    const frame = stripAnsi(
      renderFrame(state({ total: undefined, rows: [row('a', 'pass')] }), {
        width: 60,
        maxRows: 10,
      })
    );
    expect(frame).not.toContain('%');
    expect(frame).toContain('✓1');
  });

  it('scrolls: shows the last N rows with an "earlier" indicator', () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`req ${i}`, 'pass'));
    const frame = renderFrame(state({ rows, total: 5 }), { width: 50, maxRows: 3 });
    const plain = stripAnsi(frame);
    expect(plain).toContain('… 2 earlier'); // 5 rows, window 3
    expect(plain).toContain('req 4'); // newest shown
    expect(plain).not.toContain('req 1'); // oldest dropped
    for (const w of widths(frame)) expect(w).toBe(50);
  });

  it('reserves a line for the in-flight request with a spinner', () => {
    const frame = stripAnsi(
      renderFrame(
        state({
          rows: [row('done', 'pass')],
          current: { method: 'POST', name: 'in flight', outcome: 'running' },
        }),
        { width: 50, maxRows: 10 }
      )
    );
    expect(frame).toContain('in flight');
    expect(frame).toContain('POST');
  });

  it('truncates long request names with an ellipsis, preserving width', () => {
    const frame = renderFrame(state({ rows: [row('a'.repeat(200), 'pass')] }), {
      width: 40,
      maxRows: 10,
    });
    expect(stripAnsi(frame)).toContain('…');
    for (const w of widths(frame)) expect(w).toBe(40);
  });
});
