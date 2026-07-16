import { describe, expect, it, vi } from 'vitest';
import { selectCheckRun, waitForCheckRun } from '../scripts/ci/wait-for-check-run.mjs';

const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);

function checkRun(
  overrides: Partial<{
    id: number;
    name: string;
    head_sha: string;
    status: string;
    conclusion: string | null;
    started_at: string;
  }> = {}
) {
  return {
    id: 1,
    name: 'merge-gate',
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-07-16T00:00:00Z',
    ...overrides,
  };
}

describe('exact-SHA check-run selection', () => {
  it('distinguishes missing, pending, failure, and success', () => {
    expect(selectCheckRun([], sha, 'merge-gate').state).toBe('missing');
    expect(selectCheckRun([checkRun({ head_sha: otherSha })], sha, 'merge-gate').state).toBe(
      'missing'
    );
    expect(
      selectCheckRun([checkRun({ status: 'in_progress', conclusion: null })], sha, 'merge-gate')
        .state
    ).toBe('pending');
    expect(selectCheckRun([checkRun({ conclusion: 'failure' })], sha, 'merge-gate').state).toBe(
      'failure'
    );
    expect(selectCheckRun([checkRun()], sha, 'merge-gate').state).toBe('success');
  });

  it('uses the newest matching run without borrowing another SHA', () => {
    const result = selectCheckRun(
      [
        checkRun({ id: 1, head_sha: otherSha, conclusion: 'success' }),
        checkRun({ id: 2, conclusion: 'failure' }),
        checkRun({ id: 3, status: 'in_progress', conclusion: null }),
      ],
      sha,
      'merge-gate'
    );

    expect(result.state).toBe('pending');
    expect(result.run?.id).toBe(3);
  });
});

describe('check-run polling', () => {
  it('waits through missing and pending states until exact-SHA success', async () => {
    const payloads = [
      { check_runs: [checkRun({ head_sha: otherSha })] },
      { check_runs: [checkRun({ status: 'queued', conclusion: null })] },
      { check_runs: [checkRun()] },
    ];
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(payloads.shift()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const sleep = vi.fn(async () => {});

    const result = await waitForCheckRun({
      owner: 'dipjyotimetia',
      repo: 'restura',
      sha,
      name: 'merge-gate',
      token: 'test-token',
      timeoutMs: 1000,
      pollMs: 1,
      fetchImpl,
      sleep,
      now: () => 0,
    });

    expect(result.id).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(`/commits/${sha}/check-runs`);
  });

  it('fails immediately when the exact-SHA check completes unsuccessfully', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ check_runs: [checkRun({ conclusion: 'cancelled' })] }), {
          status: 200,
        })
    );

    await expect(
      waitForCheckRun({
        owner: 'dipjyotimetia',
        repo: 'restura',
        sha,
        name: 'merge-gate',
        token: 'test-token',
        timeoutMs: 1000,
        pollMs: 1,
        fetchImpl,
        sleep: async () => {},
        now: () => 0,
      })
    ).rejects.toThrow('cancelled');
  });

  it('times out with the requested SHA and check name', async () => {
    const times = [0, 1001];
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ check_runs: [] }), { status: 200 })
    );

    await expect(
      waitForCheckRun({
        owner: 'dipjyotimetia',
        repo: 'restura',
        sha,
        name: 'merge-gate',
        token: 'test-token',
        timeoutMs: 1000,
        pollMs: 1,
        fetchImpl,
        sleep: async () => {},
        now: () => times.shift() ?? 1001,
      })
    ).rejects.toThrow(`Timed out waiting for merge-gate on ${sha}`);
  });
});
