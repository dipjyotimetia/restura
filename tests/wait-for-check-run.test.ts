import { describe, expect, it, vi } from 'vitest';
import {
  selectCheckRun,
  validateWorkflowRun,
  waitForCheckRun,
} from '../scripts/ci/wait-for-check-run.mjs';

const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const owner = 'dipjyotimetia';
const repo = 'restura';

function checkRun(
  overrides: Partial<{
    id: number;
    name: string;
    head_sha: string;
    status: string;
    conclusion: string | null;
    started_at: string;
    details_url: string;
    app: { slug: string };
  }> = {}
) {
  return {
    id: 1,
    name: 'merge-gate',
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-07-16T00:00:00Z',
    details_url: `https://github.com/${owner}/${repo}/actions/runs/42/job/100`,
    app: { slug: 'github-actions' },
    ...overrides,
  };
}

describe('exact-SHA check-run selection', () => {
  it('distinguishes missing, pending, failure, and success', () => {
    expect(selectCheckRun([], sha, 'merge-gate', owner, repo).state).toBe('missing');
    expect(
      selectCheckRun([checkRun({ head_sha: otherSha })], sha, 'merge-gate', owner, repo).state
    ).toBe('missing');
    expect(
      selectCheckRun(
        [checkRun({ status: 'in_progress', conclusion: null })],
        sha,
        'merge-gate',
        owner,
        repo
      ).state
    ).toBe('pending');
    expect(
      selectCheckRun([checkRun({ conclusion: 'failure' })], sha, 'merge-gate', owner, repo).state
    ).toBe('failure');
    expect(selectCheckRun([checkRun()], sha, 'merge-gate', owner, repo).state).toBe('success');
  });

  it('rejects same-name checks from another app or repository', () => {
    expect(
      selectCheckRun([checkRun({ app: { slug: 'another-app' } })], sha, 'merge-gate', owner, repo)
        .state
    ).toBe('missing');
    expect(
      selectCheckRun(
        [checkRun({ details_url: 'https://github.com/other/repo/actions/runs/42/job/100' })],
        sha,
        'merge-gate',
        owner,
        repo
      ).state
    ).toBe('missing');
  });

  it('uses the newest matching run without borrowing another SHA', () => {
    const result = selectCheckRun(
      [
        checkRun({ id: 1, head_sha: otherSha, conclusion: 'success' }),
        checkRun({ id: 2, conclusion: 'failure' }),
        checkRun({ id: 3, status: 'in_progress', conclusion: null }),
      ],
      sha,
      'merge-gate',
      owner,
      repo
    );

    expect(result.state).toBe('pending');
    expect(result.run?.id).toBe(3);
  });
});

describe('trusted workflow identity', () => {
  it('accepts only the repository CI workflow on the exact SHA', () => {
    const run = {
      path: '.github/workflows/ci.yml',
      head_sha: sha,
      conclusion: 'success',
      event: 'push',
      head_branch: 'main',
      repository: { full_name: `${owner}/${repo}` },
    };
    expect(validateWorkflowRun(run, { owner, repo, sha })).toBeNull();
    expect(
      validateWorkflowRun({ ...run, path: '.github/workflows/other.yml' }, { owner, repo, sha })
    ).toContain('workflow path');
    expect(
      validateWorkflowRun({ ...run, repository: { full_name: 'other/repo' } }, { owner, repo, sha })
    ).toContain('repository');
    expect(validateWorkflowRun({ ...run, event: 'pull_request' }, { owner, repo, sha })).toContain(
      'push event'
    );
    expect(validateWorkflowRun({ ...run, head_branch: 'other' }, { owner, repo, sha })).toContain(
      'main branch'
    );
    expect(validateWorkflowRun({ ...run, head_sha: otherSha }, { owner, repo, sha })).toContain(
      'head SHA'
    );
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
      async (input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify(
            String(input).includes('/actions/runs/')
              ? {
                  path: '.github/workflows/ci.yml',
                  head_sha: sha,
                  conclusion: 'success',
                  event: 'push',
                  head_branch: 'main',
                  repository: { full_name: `${owner}/${repo}` },
                }
              : payloads.shift()
          ),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
    );
    const sleep = vi.fn(async () => {});

    const result = await waitForCheckRun({
      owner,
      repo,
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
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(`/commits/${sha}/check-runs`);
  });

  it('rejects success produced by a different workflow file', async () => {
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify(
            String(input).includes('/actions/runs/')
              ? {
                  path: '.github/workflows/release.yml',
                  head_sha: sha,
                  conclusion: 'success',
                  event: 'push',
                  head_branch: 'main',
                  repository: { full_name: `${owner}/${repo}` },
                }
              : { check_runs: [checkRun()] }
          ),
          { status: 200 }
        )
    );

    await expect(
      waitForCheckRun({
        owner,
        repo,
        sha,
        name: 'merge-gate',
        token: 'test-token',
        timeoutMs: 1000,
        pollMs: 1,
        fetchImpl,
        sleep: async () => {},
        now: () => 0,
      })
    ).rejects.toThrow('workflow path');
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
        owner,
        repo,
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
        owner,
        repo,
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
