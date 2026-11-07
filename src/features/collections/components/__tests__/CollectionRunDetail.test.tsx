import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectionRequestResult, CollectionRunResult } from '../../lib/collectionRunner';
import { CollectionRunDetail } from '../CollectionRunDetail';

const downloadBlob = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shared/file-utils', () => ({ downloadBlob }));
vi.mock('../../lib/collectionRunExport', () => ({
  renderCollectionRunJson: (run: CollectionRunResult) => `json:${run.id}`,
  renderCollectionRunJUnit: (run: CollectionRunResult) => `junit:${run.id}`,
  renderCollectionRunHtml: (run: CollectionRunResult) => `html:${run.id}`,
}));

function req(over: Partial<CollectionRequestResult> = {}): CollectionRequestResult {
  return {
    itemId: 'r1',
    itemName: 'Get users',
    protocol: 'http',
    iteration: 0,
    status: 'success',
    httpStatus: 200,
    durationMs: 12,
    assertions: [],
    ...over,
  };
}

function run(requests: CollectionRequestResult[], over: Partial<CollectionRunResult> = {}) {
  const passed = requests.filter((r) => r.status === 'success').length;
  const failed = requests.filter((r) => r.status === 'failed').length;
  const skipped = requests.filter((r) => r.status === 'skipped').length;
  return {
    id: 'run-1',
    collectionId: 'c',
    collectionName: 'API',
    scopeName: 'API scope',
    startedAt: 0,
    durationMs: 99,
    iterations: 1,
    dataRows: 0,
    outcome: 'completed',
    requests,
    summary: { total: requests.length, passed, failed, skipped },
    ...over,
  } satisfies CollectionRunResult;
}

const evidence = {
  contentType: 'application/json',
  sizeBytes: 42,
  headers: {},
  truncated: false,
  redacted: false,
  binary: false,
  unavailable: false,
};

describe('CollectionRunDetail', () => {
  beforeEach(() => downloadBlob.mockReset());

  it('renders nothing without a run', () => {
    const { container } = render(<CollectionRunDetail run={null} onClose={vi.fn()} />);
    expect(container.innerHTML).toBe('');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows summary, per-request rows, assertions, errors and evidence', () => {
    const r = run([
      req({
        assertions: [
          { name: 'status is 200', passed: true },
          { name: 'has body', passed: false, error: 'expected body' },
          { name: 'no error text', passed: false },
        ],
        evidence: { ...evidence, excerpt: '{"ok":true}', truncated: true, redacted: true },
      }),
      req({
        itemId: 'r2',
        itemName: 'Broken',
        protocol: 'grpc',
        status: 'failed',
        httpStatus: 14,
        durationMs: undefined,
        error: 'UNAVAILABLE',
        evidence: { ...evidence, contentType: '', unavailable: true, binary: true },
      }),
      req({
        itemId: 'r3',
        itemName: 'Skipped one',
        protocol: 'customproto',
        status: 'skipped',
        httpStatus: undefined,
        skippedReason: 'Not supported in runner',
        evidence: { ...evidence, unavailable: true },
      }),
      req({
        itemId: 'r4',
        itemName: 'Plain text',
        evidence: { ...evidence, contentType: '' },
      }),
    ]);
    render(<CollectionRunDetail run={r} onClose={vi.fn()} />);

    expect(screen.getByText('API scope')).toBeTruthy();
    expect(screen.getByText('2 passed')).toBeTruthy();
    expect(screen.getByText('1 failed')).toBeTruthy();
    expect(screen.getByText('1 skipped')).toBeTruthy();
    expect(screen.getAllByText('HTTP')).toHaveLength(2);
    expect(screen.getByText('gRPC')).toBeTruthy();
    // Unknown protocol falls back to the upper-cased id.
    expect(screen.getByText('CUSTOMPROTO')).toBeTruthy();
    expect(screen.getAllByText('12ms').length).toBeGreaterThan(0);
    expect(screen.getByText('14')).toBeTruthy();
    expect(screen.getByText('UNAVAILABLE')).toBeTruthy();
    expect(screen.getByText('Not supported in runner')).toBeTruthy();
    expect(screen.getByText('status is 200')).toBeTruthy();
    expect(screen.getByText('has body — expected body')).toBeTruthy();
    expect(screen.getByText('no error text')).toBeTruthy();
    expect(
      screen.getByText('application/json · 42 bytes · excerpt truncated · redacted')
    ).toBeTruthy();
    expect(screen.getByText('{"ok":true}')).toBeTruthy();
    expect(
      screen.getByText('Response evidence unavailable: binary body was not retained.')
    ).toBeTruthy();
    expect(screen.getByText('Response evidence was not retained.')).toBeTruthy();
    expect(screen.getByText('text · 42 bytes')).toBeTruthy();
    // No onRerun → no per-request run buttons, no iteration headers for 1 iteration.
    expect(screen.queryByRole('button', { name: 'Run request' })).toBeNull();
    expect(screen.queryByText(/Iteration 1/)).toBeNull();
  });

  it('omits the skipped count when nothing was skipped and disables rerun-failed', () => {
    render(<CollectionRunDetail run={run([req()])} onClose={vi.fn()} />);
    expect(screen.queryByText(/skipped/)).toBeNull();
    expect(
      (screen.getByRole('button', { name: /Rerun failed/ }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('reruns failed and individual requests', () => {
    const onRerun = vi.fn();
    const r = run([
      req(),
      req({ itemId: 'bad1', status: 'failed', httpStatus: 500 }),
      req({ itemId: 'bad2', status: 'failed', httpStatus: 503 }),
    ]);
    render(<CollectionRunDetail run={r} onClose={vi.fn()} onRerun={onRerun} />);
    fireEvent.click(screen.getByRole('button', { name: /Rerun failed/ }));
    expect(onRerun).toHaveBeenLastCalledWith(['bad1', 'bad2']);
    const perRow = screen.getAllByRole('button', { name: /Run request/ });
    expect(perRow).toHaveLength(3);
    fireEvent.click(perRow[1]!);
    expect(onRerun).toHaveBeenLastCalledWith(['bad1']);
  });

  it('rerun failed is a no-op without an onRerun handler', () => {
    render(<CollectionRunDetail run={run([req({ status: 'failed' })])} onClose={vi.fn()} />);
    // Enabled because there is a failure; clicking must not throw.
    fireEvent.click(screen.getByRole('button', { name: /Rerun failed/ }));
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('downloads JSON, JUnit and HTML exports', () => {
    render(<CollectionRunDetail run={run([req()])} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /JSON/ }));
    fireEvent.click(screen.getByRole('button', { name: /JUnit/ }));
    fireEvent.click(screen.getByRole('button', { name: /HTML/ }));
    expect(downloadBlob.mock.calls).toEqual([
      ['json:run-1', 'restura-run-run-1.json'],
      ['junit:run-1', 'restura-run-run-1.xml', 'application/xml'],
      ['html:run-1', 'restura-run-run-1.html', 'text/html'],
    ]);
  });

  it('groups by iteration with headers when there are several iterations', () => {
    const r = run(
      [
        req({ iteration: 1, itemName: 'second pass' }),
        req({ iteration: 0, itemName: 'first pass' }),
      ],
      { iterations: 2 }
    );
    render(<CollectionRunDetail run={r} onClose={vi.fn()} />);
    const headers = screen.getAllByText(/^Iteration \d$/).map((n) => n.textContent);
    expect(headers).toEqual(['Iteration 1', 'Iteration 2']);
  });

  it('compares against a previous run', () => {
    const current = run([
      req({ itemId: 'same', evidence: { ...evidence, hash: 'h1' } }),
      req({ itemId: 'changed', httpStatus: 500, status: 'failed', durationMs: 30 }),
      req({ itemId: 'changedNoStatus', httpStatus: undefined, durationMs: undefined }),
      req({ itemId: 'new' }),
    ]);
    const previous = run(
      [
        req({ itemId: 'same', evidence: { ...evidence, hash: 'h1' } }),
        req({ itemId: 'changed', httpStatus: 200, durationMs: 10 }),
        req({ itemId: 'changedNoStatus', httpStatus: undefined, status: 'failed' }),
      ],
      { scopeName: 'Yesterday' }
    );
    render(<CollectionRunDetail run={current} onClose={vi.fn()} comparisonRun={previous} />);
    expect(screen.getByText(/Comparing with Yesterday/)).toBeTruthy();
    expect(screen.getByText('No status or retained-evidence change.')).toBeTruthy();
    expect(screen.getByText('Changed: 200 → 500 · 20ms latency delta')).toBeTruthy();
    expect(screen.getByText('Changed: - → - · -12ms latency delta')).toBeTruthy();
    expect(screen.getByText('No matching request in comparison run.')).toBeTruthy();
  });

  it('calls onClose when the dialog is dismissed', () => {
    const onClose = vi.fn();
    render(<CollectionRunDetail run={run([req()])} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
