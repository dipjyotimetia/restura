#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

function trustedActionsRunId(checkRun, owner, repo) {
  if (checkRun?.app?.slug !== 'github-actions') return null;
  try {
    const details = new URL(checkRun.details_url);
    const segments = details.pathname.split('/').filter(Boolean);
    if (
      details.protocol !== 'https:' ||
      details.hostname !== 'github.com' ||
      segments[0] !== owner ||
      segments[1] !== repo ||
      segments[2] !== 'actions' ||
      segments[3] !== 'runs' ||
      !/^\d+$/.test(segments[4] || '') ||
      segments[5] !== 'job' ||
      !/^\d+$/.test(segments[6] || '')
    ) {
      return null;
    }
    return segments[4];
  } catch {
    return null;
  }
}

export function selectCheckRun(checkRuns, sha, name, owner, repo) {
  const run = checkRuns
    .filter(
      (candidate) =>
        candidate?.name === name &&
        candidate?.head_sha === sha &&
        trustedActionsRunId(candidate, owner, repo)
    )
    .sort((left, right) => Number(right.id || 0) - Number(left.id || 0))[0];
  if (!run) return { state: 'missing', message: `${name} is not present on ${sha}` };
  if (run.status !== 'completed') {
    return { state: 'pending', message: `${name} is ${run.status}`, run };
  }
  if (run.conclusion === 'success') {
    return { state: 'success', message: `${name} succeeded`, run };
  }
  return {
    state: 'failure',
    message: `${name} completed with ${run.conclusion || 'no conclusion'}`,
    run,
  };
}

export function validateWorkflowRun(workflowRun, { owner, repo, sha }) {
  if (workflowRun?.repository?.full_name !== `${owner}/${repo}`) {
    return 'workflow repository does not match the release repository';
  }
  if (workflowRun?.path !== '.github/workflows/ci.yml') {
    return 'workflow path is not .github/workflows/ci.yml';
  }
  if (workflowRun?.event !== 'push') {
    return 'workflow is not a push event';
  }
  if (workflowRun?.head_branch !== 'main') {
    return 'workflow is not a main branch run';
  }
  if (workflowRun?.head_sha !== sha) {
    return 'workflow head SHA does not match the release candidate';
  }
  if (workflowRun?.conclusion !== 'success') {
    return `workflow conclusion is ${workflowRun?.conclusion || 'missing'}`;
  }
  return null;
}

export async function waitForCheckRun({
  owner,
  repo,
  sha,
  name,
  token,
  timeoutMs,
  pollMs,
  fetchImpl = fetch,
  sleep = delay,
  now = Date.now,
  onState = () => {},
}) {
  const startedAt = now();
  let lastMessage = null;
  while (true) {
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs`);
    url.searchParams.set('check_name', name);
    url.searchParams.set('filter', 'latest');
    url.searchParams.set('per_page', '100');
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub Check Runs API returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    const selection = selectCheckRun(
      Array.isArray(payload?.check_runs) ? payload.check_runs : [],
      sha,
      name,
      owner,
      repo
    );
    if (selection.message !== lastMessage) {
      onState(selection.message);
      lastMessage = selection.message;
    }
    if (selection.state === 'success') {
      const actionsRunId = trustedActionsRunId(selection.run, owner, repo);
      if (!actionsRunId) throw new Error('successful check is not from trusted GitHub Actions');
      const workflowResponse = await fetchImpl(
        `https://api.github.com/repos/${owner}/${repo}/actions/runs/${actionsRunId}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );
      if (!workflowResponse.ok) {
        throw new Error(`GitHub Actions Runs API returned HTTP ${workflowResponse.status}`);
      }
      const workflowRun = await workflowResponse.json();
      const validationError = validateWorkflowRun(workflowRun, { owner, repo, sha });
      if (validationError)
        throw new Error(`Trusted workflow verification failed: ${validationError}`);
      return selection.run;
    }
    if (selection.state === 'failure') throw new Error(selection.message);
    if (now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for ${name} on ${sha}`);
    }
    await sleep(pollMs);
  }
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value == null)
      throw new Error(`Invalid argument: ${flag || ''}`);
    values.set(flag.slice(2), value);
  }
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repository = args.get('repo') || '';
  const [owner, repo, extra] = repository.split('/');
  const sha = args.get('sha') || '';
  const name = args.get('name') || '';
  const timeoutSeconds = Number(args.get('timeout-seconds') || '2400');
  const pollSeconds = Number(args.get('poll-seconds') || '15');
  const token = process.env.GITHUB_TOKEN || '';

  if (!owner || !repo || extra) throw new Error('--repo must be owner/name');
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('--sha must be a 40-character hex SHA');
  if (!name) throw new Error('--name is required');
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('--timeout-seconds must be positive');
  }
  if (!Number.isFinite(pollSeconds) || pollSeconds <= 0) {
    throw new Error('--poll-seconds must be positive');
  }
  if (!token) throw new Error('GITHUB_TOKEN is required');

  const run = await waitForCheckRun({
    owner,
    repo,
    sha,
    name,
    token,
    timeoutMs: timeoutSeconds * 1000,
    pollMs: pollSeconds * 1000,
    onState: (message) => process.stdout.write(`${message}\n`),
  });
  process.stdout.write(`${name} authorized by check run ${run.id} on ${sha}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release check gate: ${message}\n`);
    process.exitCode = 1;
  });
}
