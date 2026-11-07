import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLoadTestStore } from '@/store/useLoadTestStore';
import type { HttpRequest } from '@/types';
import type { LoadProgress } from '../../lib/loadTestRunner';
import { LoadTestDialog } from '../LoadTestDialog';

const hook = vi.hoisted(() => ({
  running: false,
  progress: null as LoadProgress | null,
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('../../hooks/useLoadTest', () => ({ useLoadTest: () => hook }));

const platform = vi.hoisted(() => ({ electron: false }));
vi.mock('@/lib/shared/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/platform')>()),
  isElectron: () => platform.electron,
}));

const request: HttpRequest = {
  id: 'r',
  name: 'Ping',
  type: 'http',
  method: 'POST',
  url: 'https://example.com/ping',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
};

const sample = (timeMs: number, ok = true) => ({ timeMs, status: ok ? 200 : 500, ok });

describe('LoadTestDialog progress and recording', () => {
  beforeEach(() => {
    hook.running = false;
    hook.progress = null;
    hook.start.mockReset();
    hook.stop.mockReset();
    platform.electron = false;
    useLoadTestStore.setState({ runs: [] });
  });

  it('shows "No request" and disables Run without a request', () => {
    render(<LoadTestDialog request={null} open onClose={vi.fn()} />);
    expect(screen.getByText('No request')).toBeTruthy();
    const run = screen.getByRole('button', { name: /Run/ }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    fireEvent.click(run);
    expect(hook.start).not.toHaveBeenCalled();
  });

  it('warns about browser connection limits on web only', () => {
    const { unmount } = render(<LoadTestDialog request={request} open onClose={vi.fn()} />);
    expect(screen.getByText(/Browsers cap concurrent connections/)).toBeTruthy();
    expect(screen.getByText('POST https://example.com/ping')).toBeTruthy();
    unmount();
    platform.electron = true;
    render(<LoadTestDialog request={request} open onClose={vi.fn()} />);
    expect(screen.queryByText(/Browsers cap concurrent connections/)).toBeNull();
  });

  it('floors invalid input to 1 and clears the cap notice once back in range', () => {
    render(<LoadTestDialog request={request} open onClose={vi.fn()} />);
    const total = screen.getByRole('spinbutton', { name: 'Total requests' }) as HTMLInputElement;
    const concurrency = screen.getByRole('spinbutton', { name: 'Concurrency' }) as HTMLInputElement;
    fireEvent.change(total, { target: { value: '999999' } });
    expect(total.getAttribute('aria-describedby')).toBe('load-test-iterations-cap');
    expect(screen.getByRole('status')).toBeTruthy();
    fireEvent.change(total, { target: { value: '0' } });
    expect(total.value).toBe('1');
    expect(total.getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.change(concurrency, { target: { value: '-4' } });
    expect(concurrency.value).toBe('1');
    fireEvent.change(concurrency, { target: { value: '7.9' } });
    expect(concurrency.value).toBe('7');
    fireEvent.click(screen.getByRole('button', { name: /Run/ }));
    expect(hook.start).toHaveBeenCalledWith(request, { iterations: 1, concurrency: 7 });
  });

  it('offers Stop and locks inputs while running', () => {
    hook.running = true;
    hook.progress = { samples: [], completed: 0, total: 10, elapsedMs: 0, done: false };
    render(<LoadTestDialog request={request} open onClose={vi.fn()} />);
    expect(
      (screen.getByRole('spinbutton', { name: 'Total requests' }) as HTMLInputElement).disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
    expect(hook.stop).toHaveBeenCalled();
    expect(screen.getByText('0 / 10 · 0%')).toBeTruthy();
    expect(screen.getByText('0.0')).toBeTruthy();
  });

  it('renders stats, percentile bars and errors, and records a finished run once', () => {
    hook.progress = {
      samples: [sample(10), sample(20), sample(30), sample(40), sample(5, false)],
      completed: 5,
      total: 5,
      elapsedMs: 2000,
      done: true,
    };
    const { rerender } = render(<LoadTestDialog request={request} open onClose={vi.fn()} />);
    expect(screen.getByText('5 / 5 · 100% · done')).toBeTruthy();
    expect(screen.getByText('2.5')).toBeTruthy();
    expect(screen.getByText('Req/s')).toBeTruthy();
    for (const label of ['p50', 'p90', 'p95', 'p99']) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText('1 error (non-2xx/3xx or failed)')).toBeTruthy();

    const runs = useLoadTestStore.getState().runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      method: 'POST',
      url: 'https://example.com/ping',
      requestName: 'Ping',
      rps: 2.5,
    });
    expect(runs[0]?.stats.errors).toBe(1);

    rerender(<LoadTestDialog request={request} open onClose={vi.fn()} />);
    expect(useLoadTestStore.getState().runs).toHaveLength(1);
  });

  it('pluralises errors and names unnamed requests by URL', () => {
    hook.progress = {
      samples: [sample(1, false), sample(2, false)],
      completed: 2,
      total: 4,
      elapsedMs: 1000,
      done: true,
    };
    render(<LoadTestDialog request={{ ...request, name: '' }} open onClose={vi.fn()} />);
    expect(screen.getByText('2 errors (non-2xx/3xx or failed)')).toBeTruthy();
    expect(screen.getByText('2 / 4 · 50% · done')).toBeTruthy();
    expect(useLoadTestStore.getState().runs[0]?.requestName).toBe('https://example.com/ping');
  });

  it('does not record an unfinished run', () => {
    hook.progress = {
      samples: [sample(10)],
      completed: 1,
      total: 3,
      elapsedMs: 100,
      done: false,
    };
    render(<LoadTestDialog request={request} open onClose={vi.fn()} />);
    expect(screen.queryByText(/error/)).toBeNull();
    expect(useLoadTestStore.getState().runs).toHaveLength(0);
  });

  it('closes via the dialog', () => {
    const onClose = vi.fn();
    render(<LoadTestDialog request={request} open onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
