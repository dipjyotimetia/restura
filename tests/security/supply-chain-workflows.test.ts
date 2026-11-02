// Supply-chain invariants for every GitHub Actions workflow (epic #1283).
// zizmor (workflow-lint.yml) covers generic Actions hazards; these pin the
// Restura-specific rules from docs/SUPPLY_CHAIN_HARDENING.md so a workflow edit
// can't quietly undo them.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOW_DIR = resolve(process.cwd(), '.github/workflows');
const workflows = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml'))
  .map((file) => ({ file, source: readFileSync(join(WORKFLOW_DIR, file), 'utf8') }));

/** Top-level job blocks (`  <id>:` under `jobs:`), keyed by job id. */
function jobsOf(source: string): Array<{ id: string; body: string }> {
  const jobsStart = source.search(/^jobs:\s*$/m);
  if (jobsStart === -1) return [];
  const lines = source.slice(jobsStart).split('\n').slice(1);
  const jobs: Array<{ id: string; lines: string[] }> = [];
  for (const line of lines) {
    const header = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (header?.[1]) jobs.push({ id: header[1], lines: [] });
    else jobs.at(-1)?.lines.push(line);
  }
  return jobs.map((j) => ({ id: j.id, body: j.lines.join('\n') }));
}

/** `run:` command lines that install the repo's (not a pinned CI tool's) deps. */
function repoInstallLines(body: string): string[] {
  return body
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .filter((l) => /\bnpm (ci|install)\b/.test(l))
    .filter((l) => !/--prefix \.github\/tools\//.test(l))
    .filter((l) => !/npm install --global npm@/.test(l))
    .filter((l) => !/--package-lock-only/.test(l));
}

const RELEASE_WORKFLOWS = [
  'release.yml',
  'release-signing-check.yml',
  'extension-vscode-release.yml',
  'extension-chrome-release.yml',
];

describe('supply-chain workflow invariants', () => {
  it('installs repo dependencies with install scripts disabled everywhere', () => {
    const offenders = workflows.flatMap(({ file, source }) =>
      repoInstallLines(source)
        .filter((l) => !l.includes('--ignore-scripts'))
        .map((l) => `${file}: ${l.trim()}`)
    );
    expect(offenders).toEqual([]);
  });

  it('never installs or builds repo dependencies in a job that can mint an OIDC token', () => {
    const offenders: string[] = [];
    for (const { file, source } of workflows) {
      for (const job of jobsOf(source)) {
        if (!/^\s+id-token: write\b/m.test(job.body)) continue;
        if (repoInstallLines(job.body).length > 0) offenders.push(`${file} → ${job.id}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps provenance and npm publishing in their own artifact-only jobs', () => {
    const release = workflows.find((w) => w.file === 'release.yml');
    expect(release).toBeDefined();
    const jobs = new Map(jobsOf(release?.source ?? '').map((j) => [j.id, j.body]));
    const holders = [...jobs]
      .filter(([, body]) => /^\s+id-token: write\b/m.test(body))
      .map(([id]) => id);
    expect(holders.sort()).toEqual(['attest-desktop', 'attest-image', 'publish-cli']);
    for (const id of ['attest-desktop', 'attest-image']) {
      expect(jobs.get(id), id).not.toContain('actions/checkout@');
    }
    expect(jobs.get('publish-cli')).toContain('npm publish "$TARBALL"');
    // npm 12 treats a bare `dist-npm/x.tgz` as GitHub shorthand (EALLOWGIT).
    expect(jobs.get('publish-cli')).toContain('tarballs=(./dist-npm/*.tgz)');
  });

  it('drops the checkout token unless a job deliberately pushes', () => {
    const offenders: string[] = [];
    for (const { file, source } of workflows) {
      const steps = source.split(/\n(?=\s*- (?:name:|uses:))/);
      for (const step of steps) {
        if (!/uses: actions\/checkout@/.test(step)) continue;
        if (/persist-credentials: false/.test(step)) continue;
        // An explicit `true` must carry a zizmor suppression with a reason.
        if (/persist-credentials: true # zizmor: ignore\[artipacked\] -- \S/.test(step)) continue;
        offenders.push(`${file}: ${step.trim().split('\n')[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('grants no write scope at workflow level', () => {
    const offenders = workflows
      .filter(({ source }) => {
        const block = source.match(/^permissions:\n((?: {2}.*\n)+)/m)?.[1] ?? '';
        return /: write\b/.test(block);
      })
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('restores no dependency cache in release, signing or extension jobs', () => {
    for (const file of RELEASE_WORKFLOWS) {
      const source = workflows.find((w) => w.file === file)?.source ?? '';
      expect(source, file).not.toMatch(/^\s+cache: ["']?npm["']?\s*$/m);
      expect(source, file).not.toContain('type=gha');
    }
  });

  it('publishes extensions from jobs that install only the pinned publishers', () => {
    for (const file of ['extension-vscode-release.yml', 'extension-chrome-release.yml']) {
      const source = workflows.find((w) => w.file === file)?.source ?? '';
      const publish = jobsOf(source).find((j) => j.id === 'publish');
      expect(publish, file).toBeDefined();
      expect(publish?.body).toContain('environment: extensions');
      expect(publish?.body).toContain('npm ci --prefix .github/tools/publish');
      expect(repoInstallLines(publish?.body ?? '')).toEqual([]);
      expect(publish?.body).not.toMatch(/^\s*run: npx /m);
    }
  });

  it("makes `cache: ''` disable setup-node's automatic npm cache too", () => {
    // setup-node auto-caches npm whenever package.json has `packageManager`,
    // even with `cache: ''`, unless package-manager-cache is false.
    const action = readFileSync(
      resolve(process.cwd(), '.github/actions/setup-node-npm/action.yml'),
      'utf8'
    );
    expect(action).toContain("package-manager-cache: ${{ inputs.cache != '' }}");
  });

  it('runs no npm-installed code in a job that keeps the checkout token', () => {
    const offenders: string[] = [];
    for (const { file, source } of workflows) {
      for (const job of jobsOf(source)) {
        if (!/persist-credentials: true/.test(job.body)) continue;
        const npmLines = job.body
          .split('\n')
          .filter((l) => !l.trim().startsWith('#'))
          .filter((l) => /\bnpm (ci|install|rebuild|exec)\b|^\s*(run: )?npx /.test(l));
        if (npmLines.length > 0) offenders.push(`${file} → ${job.id}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('attests installers downloaded by exact artifact name, never a pattern', () => {
    const release = workflows.find((w) => w.file === 'release.yml')?.source ?? '';
    const attest = jobsOf(release).find((j) => j.id === 'attest-desktop')?.body ?? '';
    expect(attest).not.toMatch(/^\s+pattern:/m);
    expect(attest).not.toContain('merge-multiple');
    for (const os of ['macOS', 'Windows', 'Linux']) {
      expect(attest).toContain(`name: installers-${os}`);
    }
  });

  it('keeps release secrets out of the job that runs `npm run validate`', () => {
    const release = workflows.find((w) => w.file === 'release.yml')?.source ?? '';
    const jobs = new Map(jobsOf(release).map((j) => [j.id, j.body]));
    expect(jobs.get('preflight')).toContain('npm run validate');
    expect(jobs.get('preflight')).not.toContain('secrets.');
    const secretsJob = (jobs.get('release-secrets') ?? '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(secretsJob).toContain('secrets.CSC_LINK');
    expect(secretsJob).not.toContain('actions/checkout@');
    expect(secretsJob).not.toMatch(/\bnpm (ci|install|run|rebuild|exec)\b/);
  });
});
