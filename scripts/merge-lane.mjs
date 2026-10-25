#!/usr/bin/env node
// Serialized merge lane (see docs/CI_CD.md "Merging: the merge lane").
//
// GitHub's merge queue needs an organization-owned repository, so this script
// is the poor man's queue. The `main` ruleset requires branches to be up to
// date ("strict" required checks), which means a PR is only mergeable after its
// required checks have run against the current tip of main. The lane keeps
// exactly ONE auto-merge PR at a time up to date; auto-merge lands it when its
// checks are green, the push to main re-triggers the lane, and the next PR is
// updated. PRs that are green alone are therefore always re-tested on top of
// every PR merged before them.
//
// Runs from .github/workflows/merge-lane.yml with a GitHub App token (pushes
// made with GITHUB_TOKEN do not trigger CI). It only ever talks to the GitHub
// API: it never checks out or executes PR code.
//
// Usage: node scripts/merge-lane.mjs --repo owner/name [--dry-run]

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const HOLD_LABEL = 'merge-lane:hold';
export const CONFLICT_LABEL = 'merge-lane:conflict';
export const CONFLICT_COMMENT_MARKER = '<!-- restura-merge-lane:conflict -->';

/** mergeStateStatus values meaning "contains the current tip of main". */
const UP_TO_DATE = new Set(['CLEAN', 'BLOCKED', 'UNSTABLE', 'HAS_HOOKS']);
/** Up to date and GitHub is about to (or may) merge it via auto-merge. */
const MERGEABLE_NOW = new Set(['CLEAN', 'UNSTABLE', 'HAS_HOOKS']);
const CHECKS_RUNNING = new Set(['PENDING', 'EXPECTED']);

/**
 * @typedef {object} LanePr
 * @property {number} number
 * @property {string} headRefOid
 * @property {boolean} isCrossRepository
 * @property {boolean} isDraft
 * @property {string} mergeStateStatus  BEHIND | BLOCKED | CLEAN | DIRTY | DRAFT | HAS_HOOKS | UNKNOWN | UNSTABLE
 * @property {string | null} reviewDecision  APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
 * @property {string | null} autoMergeEnabledAt
 * @property {string[]} labels
 * @property {string | null} checksState  statusCheckRollup state of the head commit
 */

/**
 * @typedef {object} LanePlan
 * @property {'wait' | 'update' | 'idle'} action
 * @property {LanePr | undefined} pr  the PR occupying the lane (wait) or to update (update)
 * @property {string} reason
 * @property {LanePr[]} newConflicts  conflicting PRs not yet labelled/commented
 * @property {LanePr[]} resolvedConflicts  labelled PRs that no longer conflict
 */

/** Oldest auto-merge request first; PR number breaks ties and fills gaps. */
export function laneOrder(left, right) {
  const l = left.autoMergeEnabledAt
    ? Date.parse(left.autoMergeEnabledAt)
    : Number.POSITIVE_INFINITY;
  const r = right.autoMergeEnabledAt
    ? Date.parse(right.autoMergeEnabledAt)
    : Number.POSITIVE_INFINITY;
  if (l !== r) return l - r;
  return left.number - right.number;
}

/**
 * Decide what the lane should do. Pure: the caller fetches PRs and applies
 * the plan.
 * @param {LanePr[]} prs
 * @returns {LanePlan}
 */
export function planLane(prs) {
  const eligible = prs
    .filter(
      (pr) =>
        pr.autoMergeEnabledAt !== null &&
        !pr.isCrossRepository &&
        !pr.isDraft &&
        !pr.labels.includes(HOLD_LABEL)
    )
    .sort(laneOrder);

  const newConflicts = eligible.filter(
    (pr) => pr.mergeStateStatus === 'DIRTY' && !pr.labels.includes(CONFLICT_LABEL)
  );
  const resolvedConflicts = eligible.filter(
    (pr) => pr.mergeStateStatus !== 'DIRTY' && pr.labels.includes(CONFLICT_LABEL)
  );
  const base = { newConflicts, resolvedConflicts };

  // One PR in the lane at a time: something already current with main whose
  // checks are still running, or which auto-merge is about to land.
  const occupant = eligible.find(
    (pr) =>
      UP_TO_DATE.has(pr.mergeStateStatus) &&
      (CHECKS_RUNNING.has(pr.checksState ?? '') || MERGEABLE_NOW.has(pr.mergeStateStatus))
  );
  if (occupant) {
    return {
      ...base,
      action: 'wait',
      pr: occupant,
      reason: `#${occupant.number} is up to date with main (${occupant.mergeStateStatus}, checks ${occupant.checksState ?? 'none'}); waiting for it to merge or fail`,
    };
  }

  // Updating a PR that cannot merge anyway would only burn CI minutes.
  const next = eligible.find(
    (pr) =>
      pr.mergeStateStatus === 'BEHIND' &&
      pr.reviewDecision !== 'REVIEW_REQUIRED' &&
      pr.reviewDecision !== 'CHANGES_REQUESTED'
  );
  if (next) {
    return {
      ...base,
      action: 'update',
      pr: next,
      reason: `#${next.number} is the oldest auto-merge PR behind main`,
    };
  }

  return { ...base, action: 'idle', pr: undefined, reason: 'no auto-merge PR needs updating' };
}

/** Normalise one GraphQL pull-request node into a LanePr. */
export function toLanePr(node) {
  return {
    number: node.number,
    headRefOid: node.headRefOid,
    isCrossRepository: Boolean(node.isCrossRepository),
    isDraft: Boolean(node.isDraft),
    mergeStateStatus: node.mergeStateStatus ?? 'UNKNOWN',
    reviewDecision: node.reviewDecision ?? null,
    autoMergeEnabledAt: node.autoMergeRequest?.enabledAt ?? null,
    labels: (node.labels?.nodes ?? []).map((label) => label.name),
    checksState: node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
  };
}

export function parseLaneArgs(argv, env = process.env) {
  const options = {
    repo: env.GITHUB_REPOSITORY ?? '',
    dryRun: env.MERGE_LANE_DRY_RUN === 'true',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--repo') options.repo = argv[++index] ?? '';
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo)) {
    throw new Error('--repo owner/name (or GITHUB_REPOSITORY) is required');
  }
  return options;
}

const PR_QUERY = `
query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, baseRefName: "main", first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number headRefOid isCrossRepository isDraft mergeStateStatus reviewDecision
        autoMergeRequest { enabledAt }
        labels(first: 30) { nodes { name } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

function gh(args, input) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

function fetchPrs(owner, repo) {
  const prs = [];
  let cursor;
  do {
    const args = [
      'api',
      'graphql',
      '-F',
      `owner=${owner}`,
      '-F',
      `repo=${repo}`,
      '-f',
      `query=${PR_QUERY}`,
    ];
    if (cursor) args.push('-F', `cursor=${cursor}`);
    const page = JSON.parse(gh(args)).data.repository.pullRequests;
    prs.push(...page.nodes.map(toLanePr));
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : undefined;
  } while (cursor);
  return prs;
}

function run({ repo, dryRun }) {
  const [owner, name] = repo.split('/');
  const plan = planLane(fetchPrs(owner, name));
  const act = (description, fn) => {
    console.log(`${dryRun ? '[dry-run] ' : ''}${description}`);
    if (!dryRun) fn();
  };

  for (const pr of plan.newConflicts) {
    act(`#${pr.number} conflicts with main: labelling ${CONFLICT_LABEL} and commenting`, () => {
      gh([
        'api',
        '-X',
        'POST',
        `repos/${repo}/issues/${pr.number}/labels`,
        '-f',
        `labels[]=${CONFLICT_LABEL}`,
      ]);
      gh(
        ['api', '-X', 'POST', `repos/${repo}/issues/${pr.number}/comments`, '--input', '-'],
        JSON.stringify({
          body: `${CONFLICT_COMMENT_MARKER}\nThe merge lane skipped this PR: it conflicts with \`main\` and needs a manual rebase. Rebase onto \`origin/main\`, resolve the conflicts and push; the \`${CONFLICT_LABEL}\` label is removed automatically once it merges cleanly.`,
        })
      );
    });
  }
  for (const pr of plan.resolvedConflicts) {
    act(`#${pr.number} no longer conflicts: removing ${CONFLICT_LABEL}`, () => {
      gh([
        'api',
        '-X',
        'DELETE',
        `repos/${repo}/issues/${pr.number}/labels/${encodeURIComponent(CONFLICT_LABEL)}`,
      ]);
    });
  }

  console.log(`Lane: ${plan.action} — ${plan.reason}`);
  if (plan.action === 'update' && plan.pr) {
    const pr = plan.pr;
    act(`Updating #${pr.number} with main (expected head ${pr.headRefOid.slice(0, 7)})`, () => {
      try {
        gh([
          'api',
          '-X',
          'PUT',
          `repos/${repo}/pulls/${pr.number}/update-branch`,
          '-f',
          `expected_head_sha=${pr.headRefOid}`,
        ]);
      } catch (error) {
        // 422: head moved or GitHub could not merge. The next lane run sees
        // the new state; failing the job would only add noise.
        console.warn(
          `update-branch for #${pr.number} failed: ${error instanceof Error ? error.message : error}`
        );
      }
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    run(parseLaneArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
