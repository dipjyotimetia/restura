import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { type LoadTestRun, useLoadTestStore } from '@/store/useLoadTestStore';
import { RunsPanel } from './RunsPanel';

const run = {
  id: 'run-1',
  method: 'GET',
  url: 'https://example.com/',
  requestName: 'Example',
  request: {
    id: 'r1',
    name: 'Example',
    type: 'http',
    method: 'GET',
    url: 'https://example.com/',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  },
  stats: { count: 10, errors: 0, p50: 1, p95: 2, p99: 3 },
  rps: 5,
  completedAt: Date.now(),
} as unknown as LoadTestRun;

describe('RunsPanel clear', () => {
  beforeEach(() => useLoadTestStore.setState({ runs: [run] }));

  it('asks before clearing load test runs', async () => {
    const user = userEvent.setup();
    render(<RunsPanel />);

    await user.click(screen.getByRole('button', { name: /clear/i }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Clear load test runs?');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useLoadTestStore.getState().runs).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /clear/i }));
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(useLoadTestStore.getState().runs).toHaveLength(0);
  });
});
