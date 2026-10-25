import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFLICT_LABEL, HOLD_LABEL, parseLaneArgs, planLane, toLanePr } from '../merge-lane.mjs';

const pr = (number, overrides = {}) => ({
  number,
  headRefOid: `sha${number}`,
  isCrossRepository: false,
  isDraft: false,
  mergeStateStatus: 'BEHIND',
  reviewDecision: 'APPROVED',
  autoMergeEnabledAt: `2026-10-25T00:00:${String(number % 60).padStart(2, '0')}Z`,
  labels: [],
  checksState: 'SUCCESS',
  ...overrides,
});

test('waits while an up-to-date PR still has checks running', () => {
  const plan = planLane([pr(1, { mergeStateStatus: 'BLOCKED', checksState: 'PENDING' }), pr(2)]);
  assert.equal(plan.action, 'wait');
  assert.equal(plan.pr?.number, 1);
});

test('waits while auto-merge is about to land a clean PR', () => {
  const plan = planLane([pr(2), pr(3, { mergeStateStatus: 'CLEAN' })]);
  assert.equal(plan.action, 'wait');
  assert.equal(plan.pr?.number, 3);
});

test('updates the oldest auto-merge PR that is behind main', () => {
  const plan = planLane([
    pr(5, { autoMergeEnabledAt: '2026-10-25T03:00:00Z' }),
    pr(9, { autoMergeEnabledAt: '2026-10-25T01:00:00Z' }),
    pr(7, { autoMergeEnabledAt: null }),
  ]);
  assert.equal(plan.action, 'update');
  assert.equal(plan.pr?.number, 9);
});

test('a failed up-to-date PR releases the lane to the next PR', () => {
  const plan = planLane([pr(1, { mergeStateStatus: 'BLOCKED', checksState: 'FAILURE' }), pr(2)]);
  assert.equal(plan.action, 'update');
  assert.equal(plan.pr?.number, 2);
});

test('ignores held, draft, fork and non-auto-merge PRs', () => {
  const plan = planLane([
    pr(1, { labels: [HOLD_LABEL] }),
    pr(2, { isDraft: true }),
    pr(3, { isCrossRepository: true }),
    pr(4, { autoMergeEnabledAt: null }),
    pr(5, { mergeStateStatus: 'CLEAN', autoMergeEnabledAt: null }),
  ]);
  assert.equal(plan.action, 'idle');
});

test('skips PRs whose review blocks merging', () => {
  const plan = planLane([
    pr(1, { reviewDecision: 'REVIEW_REQUIRED' }),
    pr(2, { reviewDecision: 'CHANGES_REQUESTED' }),
    pr(3, { reviewDecision: null }),
  ]);
  assert.equal(plan.pr?.number, 3);
});

test('reports new conflicts once and clears resolved ones', () => {
  const plan = planLane([
    pr(1, { mergeStateStatus: 'DIRTY' }),
    pr(2, { mergeStateStatus: 'DIRTY', labels: [CONFLICT_LABEL] }),
    pr(3, { labels: [CONFLICT_LABEL] }),
  ]);
  assert.deepEqual(
    plan.newConflicts.map((p) => p.number),
    [1]
  );
  assert.deepEqual(
    plan.resolvedConflicts.map((p) => p.number),
    [3]
  );
  assert.equal(plan.pr?.number, 3);
});

test('normalises GraphQL nodes', () => {
  assert.deepEqual(
    toLanePr({
      number: 4,
      headRefOid: 'abc',
      isCrossRepository: false,
      isDraft: false,
      mergeStateStatus: 'BEHIND',
      reviewDecision: 'APPROVED',
      autoMergeRequest: { enabledAt: '2026-10-25T01:00:00Z' },
      labels: { nodes: [{ name: 'npm' }] },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] },
    }),
    {
      number: 4,
      headRefOid: 'abc',
      isCrossRepository: false,
      isDraft: false,
      mergeStateStatus: 'BEHIND',
      reviewDecision: 'APPROVED',
      autoMergeEnabledAt: '2026-10-25T01:00:00Z',
      labels: ['npm'],
      checksState: 'PENDING',
    }
  );
  assert.equal(toLanePr({ number: 1, headRefOid: 'x' }).autoMergeEnabledAt, null);
});

test('parses lane arguments', () => {
  assert.deepEqual(parseLaneArgs(['--repo', 'a/b', '--dry-run']), { repo: 'a/b', dryRun: true });
  assert.deepEqual(parseLaneArgs([], { GITHUB_REPOSITORY: 'o/r', MERGE_LANE_DRY_RUN: 'true' }), {
    repo: 'o/r',
    dryRun: true,
  });
  assert.equal(parseLaneArgs(['--repo', 'a/b'], { MERGE_LANE_DRY_RUN: 'false' }).dryRun, false);
  assert.throws(() => parseLaneArgs(['--repo', 'nope']), /owner\/name/);
  assert.throws(() => parseLaneArgs(['--bogus']), /Unknown argument/);
});

test('an UNSTABLE PR with failed checks does not occupy the lane', () => {
  const plan = planLane([pr(1, { mergeStateStatus: 'UNSTABLE', checksState: 'FAILURE' }), pr(2)]);
  assert.equal(plan.action, 'update');
  assert.equal(plan.pr?.number, 2);
});

test('UNKNOWN mergeability keeps the conflict label', () => {
  const plan = planLane([pr(1, { mergeStateStatus: 'UNKNOWN', labels: [CONFLICT_LABEL] })]);
  assert.deepEqual(plan.resolvedConflicts, []);
});
