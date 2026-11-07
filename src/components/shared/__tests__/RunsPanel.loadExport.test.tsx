import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type LoadTestRun, useLoadTestStore } from '@/store/useLoadTestStore';
import { RunsPanel } from '../RunsPanel';

const downloadBlob = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shared/file-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/file-utils')>()),
  downloadBlob,
}));

const run: LoadTestRun = {
  id: 'run-1',
  method: 'GET',
  url: 'https://api.test',
  requestName: 'Ping',
  request: {
    id: 'r',
    name: 'Ping',
    type: 'http',
    method: 'GET',
    url: 'https://api.test',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  },
  stats: { count: 1, errors: 0, min: 1, max: 1, mean: 1, p50: 1, p90: 1, p95: 1, p99: 1, rps: 1 },
  rps: 1,
  completedAt: 0,
};

describe('RunsPanel load-test export', () => {
  beforeEach(() => {
    downloadBlob.mockReset();
    useLoadTestStore.setState({ runs: [run] });
  });

  it('exports load runs as JSON and CSV', () => {
    render(<RunsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Export load test runs as JSON' }));
    expect(downloadBlob).toHaveBeenCalledWith(
      expect.stringContaining('"id": "run-1"'),
      'restura-load-runs.json'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Export load test runs as CSV' }));
    expect(downloadBlob).toHaveBeenLastCalledWith(
      expect.stringContaining('run-1,Ping,GET'),
      'restura-load-runs.csv',
      'text/csv'
    );
  });
});
