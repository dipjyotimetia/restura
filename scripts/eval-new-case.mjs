#!/usr/bin/env node
// Scaffold a harness eval case from the PR that FIXED a seam bug.
//
//   npm run eval:new-case -- --from <fixPR#> [--id <kebab-id>]
//
// Read-only: it runs `gh pr view <n> --json title,mergeCommit,body,files` and
// read-only git (`git log`, `git rev-parse`). It finds the fix's merge commit,
// guesses the introducing PR(s) from `#nnn` references in the fix PR's body
// and commit message, proposes `base` = the first introducing PR's merge
// parent, writes evals/harness/cases/<id>.yaml with TODOs (never overwriting
// an existing case), and prints the manual steps that remain (minimise the
// patches, write the defect, anchor patterns, dry run). See the "Adding a
// case" section of evals/harness/README.md.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CASES_DIR = path.join(ROOT, 'evals/harness/cases');
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const PR_FIELDS = 'title,mergeCommit,body,files';

export function parseNewCaseArgs(argv) {
  const options = { from: null, id: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--from' || arg === '--id') {
      const value = argv[index + 1];
      index += 1;
      if (arg === '--from') {
        const n = Number(String(value ?? '').replace(/^#/, ''));
        if (!Number.isInteger(n) || n <= 0) throw new Error('--from needs a PR number');
        options.from = n;
      } else {
        if (typeof value !== 'string' || !ID_RE.test(value))
          throw new Error('--id must be kebab-case');
        options.id = value;
      }
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (options.from === null) throw new Error('--from <fixPR#> is required');
  return options;
}

/** Unique `#nnn` references in order of appearance, minus `exclude`. */
export function extractPrRefs(text, exclude = []) {
  const out = [];
  for (const match of String(text ?? '').matchAll(/(?<![\w#])#(\d{1,6})\b/g)) {
    const n = Number(match[1]);
    if (!exclude.includes(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Kebab-case id from a PR title: no conventional-commit prefix, no `(#n)`. */
export function caseIdFromTitle(title) {
  const slug = String(title ?? '')
    .replace(/^\s*[a-z]+(\([^)]*\))?!?:\s*/i, '')
    .replace(/\([^)]*#\d+[^)]*\)/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'new-case';
}

/** Product source worth putting in a patch (tests, docs, e2e, lockfiles out). */
export function isSourceFile(file) {
  if (/(^|\/)(__tests__|tests|e2e|e2e-electron|docs|docs-site)\//.test(file)) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) return false;
  if (/\.(md|mdx)$/.test(file)) return false;
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(file)) return false;
  return true;
}

function viewPr(exec, number) {
  const res = exec.run('gh', ['pr', 'view', String(number), '--json', PR_FIELDS]);
  if (res.status !== 0) return null;
  try {
    const parsed = JSON.parse(res.stdout);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function gitOut(exec, args) {
  const res = exec.run('git', args);
  return res.status === 0 ? res.stdout.trim() : null;
}

const yamlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

export function buildCaseSkeleton({ id, title, fixNumber, sources, base }) {
  const files = [...new Set(sources.flatMap((s) => s.sourceFiles))];
  const fileLines =
    files.length > 0
      ? files.map((f) => `    - ${f}   # TODO keep only the file(s) the defect lives in`)
      : ['    - TODO/path/to/defective-file.ts'];
  const sourceList = sources.map((s) => yamlString(`#${s.number}`)).join(', ');
  return [
    `id: ${id}`,
    `title: ${yamlString(`TODO one line: what breaks (fix PR: ${title})`)}`,
    'origin: real',
    '# New cases go to train unless you are deliberately growing the held-out set.',
    'split: train',
    `sourcePRs: [${sourceList || yamlString('#TODO')}]`,
    `fixPRs: [${yamlString(`#${fixNumber}`)}]`,
    base
      ? `# Proposed: the merge parent of #${sources[0].number}. Check it is the main commit the branch was cut from.`
      : '# TODO the main commit the introducing branch was cut from (full 40-char SHA).',
    `base: ${base ?? 'TODO'}`,
    'seam: cross-harness   # TODO cross-branch | cross-harness | cross-consumer',
    'branches:',
    '  - name: feat/TODO',
    '    patches: [01-TODO.patch]',
    'expected:',
    '  defect: >-',
    '    TODO what breaks and why. Fed to the judge only, never to the reviewer.',
    '  files:',
    ...fileLines,
    '  symbols: []   # TODO',
    'mustMention:',
    "  - 'TODO-anchor: a regex naming a file or symbol from expected.files / symbols'",
    "  - 'TODO keyword regex with word boundaries'",
    'mustNotMiss: medium   # TODO critical | high | medium | low',
    'notes: TODO minimisation notes (what was elided).',
    '',
  ].join('\n');
}

/** Gather everything for a skeleton. Pure apart from `exec` (read-only commands). */
export function planNewCase(exec, { from, id }) {
  const fixPr = viewPr(exec, from);
  if (!fixPr) throw new Error(`gh pr view ${from} failed (is gh authenticated? is it a PR?)`);
  const fixSha = fixPr.mergeCommit?.oid;
  if (typeof fixSha !== 'string' || !SHA_RE.test(fixSha))
    throw new Error(`PR #${from} is not merged (no mergeCommit)`);
  const message = gitOut(exec, ['log', '-1', '--format=%B', fixSha]) ?? '';
  const refs = extractPrRefs(`${fixPr.title ?? ''}\n${fixPr.body ?? ''}\n${message}`, [from]);

  const sources = [];
  const unresolvedRefs = [];
  for (const number of refs) {
    const pr = viewPr(exec, number);
    const mergeSha = pr?.mergeCommit?.oid;
    if (!pr || typeof mergeSha !== 'string' || !SHA_RE.test(mergeSha)) {
      unresolvedRefs.push(number);
      continue;
    }
    const files = Array.isArray(pr.files) ? pr.files.map((f) => f?.path).filter(Boolean) : [];
    sources.push({
      number,
      title: pr.title ?? '',
      mergeSha,
      files,
      sourceFiles: files.filter(isSourceFile),
    });
  }

  let base = null;
  if (sources.length > 0) {
    const parent = gitOut(exec, ['rev-parse', '--verify', `${sources[0].mergeSha}^1`]);
    if (parent && SHA_RE.test(parent)) base = parent;
  }
  const caseId = id ?? caseIdFromTitle(fixPr.title);
  const yaml = buildCaseSkeleton({
    id: caseId,
    title: fixPr.title ?? `#${from}`,
    fixNumber: from,
    sources,
    base,
  });

  const fixturesDir = `evals/harness/fixtures/${caseId}`;
  const steps = [
    `Check the guessed source PRs (${sources.map((s) => `#${s.number}`).join(', ') || 'none found'})` +
      (unresolvedRefs.length > 0
        ? `; these refs were not merged PRs: ${unresolvedRefs.map((n) => `#${n}`).join(', ')}`
        : '') +
      '. Edit sourcePRs and base if the incident started elsewhere.',
    `mkdir -p ${fixturesDir}`,
  ];
  for (const [index, source] of sources.entries()) {
    const files = source.sourceFiles.join(' ');
    // The first source is diffed from the proposed base; later ones from their own merge parent.
    const diffFrom = index === 0 ? (base ?? '<base>') : `${source.mergeSha}^1`;
    const patchName = `${String(index + 1).padStart(2, '0')}-<name>.patch`;
    steps.push(
      `git diff ${diffFrom} ${source.mergeSha} -- ${files || '<files>'} > ${fixturesDir}/${patchName}` +
        `   # #${source.number}; trim to the relevant hunks, keep each patch under ~300 lines`
    );
  }
  if (sources.length === 0)
    steps.push(`git diff <base> <introducing-merge> -- <files> > ${fixturesDir}/01-<name>.patch`);
  steps.push(
    `Fill every TODO in evals/harness/cases/${caseId}.yaml (defect, files, symbols, anchor mustMention, seam, severity, notes).`,
    `npm run eval:harness -- --dry-run --case ${caseId}`,
    'node --test scripts/__tests__/harness-eval.test.mjs   # anchor + distractor checks',
    'Add the case to the table in evals/harness/README.md.'
  );
  return {
    id: caseId,
    fix: { number: from, title: fixPr.title ?? '', mergeSha: fixSha },
    sources,
    unresolvedRefs,
    base,
    yaml,
    steps,
  };
}

/** Write cases/<id>.yaml; refuses to overwrite. Returns the path. */
export function writeCaseSkeleton(casesDir, id, yaml) {
  const file = path.join(casesDir, `${id}.yaml`);
  fs.mkdirSync(casesDir, { recursive: true });
  try {
    fs.writeFileSync(file, yaml, { flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`${file} exists; refusing to overwrite`);
    throw error;
  }
  return file;
}

const syncExec = {
  run(command, args) {
    const res = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  },
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const options = parseNewCaseArgs(process.argv.slice(2));
    const plan = planNewCase(syncExec, options);
    const file = writeCaseSkeleton(CASES_DIR, plan.id, plan.yaml);
    console.log(`Wrote ${path.relative(ROOT, file)} (skeleton with TODOs).`);
    console.log(`Fix: #${plan.fix.number} ${plan.fix.title} @ ${plan.fix.mergeSha.slice(0, 12)}`);
    console.log(`Proposed base: ${plan.base ?? 'none (fill it in)'}`);
    console.log('\nRemaining steps:');
    plan.steps.forEach((step, i) => {
      console.log(`  ${i + 1}. ${step}`);
    });
  } catch (error) {
    console.error(`eval-new-case: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
