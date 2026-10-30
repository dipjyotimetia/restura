#!/usr/bin/env node
// Trusted half of the Dependabot remediation loop (see docs/CI_CD.md
// "Dependabot alert remediation").
//
// The agent that edits manifests runs with no write token and no App key. Its
// patch is treated as untrusted data: this script decides what happens to it.
//
//   detect  list open npm alerts, reduced to validated fields (never advisory
//           prose, which would be attacker-influenced text in an agent prompt)
//   verify  check the patch against policy, apply it, and print a verdict:
//           reject (no PR) | hold (PR, a human merges) | merge (PR + auto-merge)
//
// Runs from .github/workflows/dependabot-remediate.yml. It has no dependencies
// and never executes anything from the patch.
//
// Usage:
//   node scripts/dependabot-remediate.mjs detect --repo owner/name --out alerts.json
//   node scripts/dependabot-remediate.mjs verify --base <sha> --patch f.patch \
//     --alerts alerts.json --body body.md

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const BRANCH = 'deps/dependabot-remediate';

const ALLOWED_PATHS =
  /^(package\.json|package-lock\.json|cli\/package\.json|extension\/[a-z-]+\/package\.json|docs-site\/package\.json|docs-site\/package-lock\.json)$/;
const DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const PACKAGE_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const GHSA_ID = /^GHSA(-[a-z0-9]{4}){3}$/i;
const VERSION = /^\d+\.\d+\.\d+[\w.+-]*$/;
const VERSION_RANGE = /^[<>=~^\d\s.,*|\w+-]+$/;
/** Plain registry ranges only: rejects `npm:` aliases, git, file: and URL specs. */
const SAFE_SPEC = /^(\^|~|>=|<=|>|<|=)?\s*\d+(\.\d+){0,2}[\w.+-]*$/;
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
const SEVERITIES = new Set(SEVERITY_ORDER);
/** More new packages than this is not what a security bump looks like. */
export const MAX_ADDED_PACKAGES = 25;

/**
 * @typedef {object} Alert
 * @property {number} number
 * @property {string} package
 * @property {string} manifest  lockfile path
 * @property {string} severity
 * @property {string} ghsa
 * @property {string} vulnerable  e.g. ">= 7.0.0, < 7.30.1"
 * @property {string | null} patched
 */

/**
 * Keep npm alerts on lockfiles the policy can touch, with only validated fields.
 * Alerts it cannot act on are returned so the workflow can warn about them.
 */
export function sanitizeAlerts(raw) {
  /** @type {Alert[]} */
  const alerts = [];
  const skipped = [];
  for (const entry of raw) {
    const name = entry?.dependency?.package?.name;
    const manifest = entry?.dependency?.manifest_path;
    const alert = {
      number: entry?.number,
      package: name,
      manifest,
      severity: entry?.security_advisory?.severity,
      ghsa: entry?.security_advisory?.ghsa_id,
      vulnerable: entry?.security_vulnerability?.vulnerable_version_range,
      patched: entry?.security_vulnerability?.first_patched_version?.identifier ?? null,
    };
    const valid =
      entry?.dependency?.package?.ecosystem === 'npm' &&
      Number.isInteger(alert.number) &&
      typeof name === 'string' &&
      PACKAGE_NAME.test(name) &&
      typeof manifest === 'string' &&
      manifest.endsWith('package-lock.json') &&
      ALLOWED_PATHS.test(manifest) &&
      SEVERITIES.has(alert.severity) &&
      typeof alert.ghsa === 'string' &&
      GHSA_ID.test(alert.ghsa) &&
      typeof alert.vulnerable === 'string' &&
      VERSION_RANGE.test(alert.vulnerable) &&
      (alert.patched === null || VERSION.test(alert.patched));
    if (valid) alerts.push(alert);
    else skipped.push(Number.isInteger(alert.number) ? alert.number : -1);
  }
  alerts.sort((a, b) => a.number - b.number);
  return { alerts, skipped };
}

/** Same open-alert set → same fingerprint, so a failed attempt is not retried every poll. */
export function fingerprint(alerts) {
  const key = alerts.map((a) => a.number).join(',');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Null when the version cannot be parsed. */
function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(String(version).trim());
  if (!match) return null;
  return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null };
}

function comparePrerelease(left, right) {
  const a = left.split('.');
  const b = right.split('.');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    if (a[i] === b[i]) continue;
    const bothNumeric = /^\d+$/.test(a[i]) && /^\d+$/.test(b[i]);
    if (bothNumeric) return Number(a[i]) - Number(b[i]);
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return Number.NaN;
  for (let i = 0; i < 3; i++) {
    const delta = a.parts[i] - b.parts[i];
    if (delta !== 0) return delta;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return comparePrerelease(a.pre, b.pre);
}

/**
 * GitHub advisory ranges are comma-joined comparators (">= 7.0.0, < 7.30.1").
 * Anything unparseable counts as vulnerable: an alert is only "resolved" when
 * that can be shown.
 */
export function inVulnerableRange(version, range) {
  for (const clause of range.split(',')) {
    const match = /^\s*(>=|<=|>|<|=)?\s*(\S+)\s*$/.exec(clause);
    if (!match) return true;
    const delta = compareVersions(version, match[2]);
    if (Number.isNaN(delta)) return true;
    const op = match[1] ?? '=';
    const holds =
      (op === '>=' && delta >= 0) ||
      (op === '<=' && delta <= 0) ||
      (op === '>' && delta > 0) ||
      (op === '<' && delta < 0) ||
      (op === '=' && delta === 0);
    if (!holds) return false;
  }
  return true;
}

/** 0.x and 0.0.x break on the left-most non-zero component, as semver ranges do. */
export function isBreakingBump(before, after) {
  const a = parseVersion(before);
  const b = parseVersion(after);
  if (!a || !b) return true;
  if (a.parts[0] !== b.parts[0]) return true;
  if (a.parts[0] === 0 && a.parts[1] !== b.parts[1]) return true;
  return a.parts[0] === 0 && a.parts[1] === 0 && a.parts[2] !== b.parts[2];
}

function specVersion(spec) {
  return String(spec)
    .replace(/^(\^|~|>=|<=|>|<|=)\s*/, '')
    .trim();
}

function walkOverrides(node, path, reasons) {
  if (typeof node === 'string') {
    if (!node.startsWith('$') && !SAFE_SPEC.test(node)) {
      reasons.push(`override ${path} uses a non-registry spec`);
    }
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      walkOverrides(value, path ? `${path} > ${key}` : key, reasons);
    }
    return;
  }
  reasons.push(`override ${path} is not a version`);
}

function stripDepSections(manifest) {
  const rest = { ...manifest };
  for (const section of [...DEP_SECTIONS, 'overrides']) delete rest[section];
  return JSON.stringify(rest);
}

/** Only version strings and overrides may change in a manifest. */
function checkManifest(path, before, after, reasons, holds) {
  if (stripDepSections(before) !== stripDepSections(after)) {
    reasons.push(`${path}: fields other than dependency versions and overrides changed`);
  }
  for (const section of DEP_SECTIONS) {
    const old = before[section] ?? {};
    const next = after[section] ?? {};
    for (const name of Object.keys(old)) {
      if (!(name in next)) reasons.push(`${path}: removed dependency ${name}`);
    }
    for (const [name, spec] of Object.entries(next)) {
      if (!(name in old)) {
        reasons.push(`${path}: added dependency ${name}`);
      } else if (old[name] !== spec) {
        if (!SAFE_SPEC.test(spec)) {
          reasons.push(`${path}: ${name} uses a non-registry spec`);
        } else if (isBreakingBump(specVersion(old[name]), specVersion(spec))) {
          holds.push(`${path}: direct major bump of \`${name}\` to ${spec}`);
        }
      }
    }
  }
  if (JSON.stringify(before.overrides) !== JSON.stringify(after.overrides)) {
    walkOverrides(after.overrides ?? {}, '', reasons);
  }
}

function packageNameOf(lockKey) {
  return lockKey.slice(lockKey.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

function isDevEntry(entry) {
  return entry?.dev === true || entry?.devOptional === true;
}

/** Every new or changed lock entry must be a real tarball of that package from npm. */
function checkLock(path, before, after, reasons, holds, upgrades) {
  const old = before.packages ?? {};
  const next = after.packages ?? {};
  let added = 0;
  for (const [key, entry] of Object.entries(next)) {
    if (key === '') continue;
    const prior = old[key];
    if (prior && JSON.stringify(prior) === JSON.stringify(entry)) continue;
    if (!key.includes('node_modules/') || entry.link) {
      // Workspace entries: their dependency ranges legitimately follow the
      // manifests (checked above), but they must not start pointing elsewhere.
      if (entry.link && (!prior || prior.resolved !== entry.resolved)) {
        reasons.push(`${path}: link entry ${key} changed`);
      }
      continue;
    }
    const name = packageNameOf(key);
    if (!PACKAGE_NAME.test(name)) {
      reasons.push(`${path}: invalid package path ${key}`);
      continue;
    }
    if (entry.name && entry.name !== name) {
      reasons.push(`${path}: ${key} is an alias for ${entry.name}`);
    }
    if (!entry.resolved?.startsWith(`https://registry.npmjs.org/${name}/-/`)) {
      reasons.push(`${path}: ${key} does not resolve to its npm tarball`);
    }
    if (!entry.integrity?.startsWith('sha512-')) {
      reasons.push(`${path}: ${key} has no sha512 integrity`);
    }
    if (entry.hasInstallScript && !prior?.hasInstallScript) {
      holds.push(`${path}: \`${name}@${entry.version}\` adds an install script`);
    }
    if (!prior) {
      added += 1;
      continue;
    }
    if (prior.version !== entry.version) {
      upgrades.push({ manifest: path, name, from: prior.version, to: entry.version });
      if (!isDevEntry(entry) && isBreakingBump(prior.version, entry.version)) {
        holds.push(
          `${path}: runtime major bump of \`${name}\` ${prior.version} → ${entry.version}`
        );
      }
    }
  }
  if (added > MAX_ADDED_PACKAGES) {
    holds.push(`${path}: adds ${added} new packages (limit ${MAX_ADDED_PACKAGES})`);
  }
}

/** Alerts with no lock copy left inside the vulnerable range. */
export function classifyAlerts(alerts, locksAfter) {
  const resolved = [];
  const unresolved = [];
  for (const alert of alerts) {
    const lock = locksAfter[alert.manifest];
    const stillVulnerable =
      !lock ||
      Object.entries(lock.packages ?? {}).some(
        ([key, entry]) =>
          key.includes('node_modules/') &&
          packageNameOf(key) === alert.package &&
          inVulnerableRange(entry.version, alert.vulnerable)
      );
    (stillVulnerable ? unresolved : resolved).push(alert);
  }
  return { resolved, unresolved };
}

/**
 * The whole policy. Pure: the caller loads manifests and locks.
 * reject → no PR. hold → PR without auto-merge. merge → PR with auto-merge,
 * still gated by every required check on `main`.
 *
 * @param {object} input
 * @param {Alert[]} input.alerts
 * @param {Array<{path: string, before: any, after: any}>} input.files
 * @param {Record<string, any>} input.locksAfter  every lockfile, changed or not
 */
export function evaluateChange({ alerts, files, locksAfter }) {
  const reasons = [];
  const holds = [];
  const upgrades = [];
  for (const { path, before, after } of files) {
    if (!ALLOWED_PATHS.test(path)) {
      reasons.push(`${path}: not a dependency manifest`);
    } else if (path.endsWith('package-lock.json')) {
      checkLock(path, before, after, reasons, holds, upgrades);
    } else {
      checkManifest(path, before, after, reasons, holds);
    }
  }
  const { resolved, unresolved } = classifyAlerts(alerts, locksAfter);
  if (resolved.length === 0) reasons.push('the patch resolves none of the open alerts');
  const decision = reasons.length > 0 ? 'reject' : holds.length > 0 ? 'hold' : 'merge';
  return { decision, reasons, holds, upgrades, resolved, unresolved };
}

/** Reject before applying: only plain edits of allowed paths reach the worktree. */
export function checkPatchShape(numstat, summary) {
  const reasons = [];
  if (summary.trim() !== '') {
    reasons.push(`patch creates, deletes, renames or re-modes files: ${summary.trim()}`);
  }
  const paths = [];
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [, , path] = line.split('\t');
    if (path === undefined || !ALLOWED_PATHS.test(path)) {
      reasons.push(`patch touches ${path ?? line}, which is not a dependency manifest`);
    } else {
      paths.push(path);
    }
  }
  if (paths.length === 0 && reasons.length === 0) reasons.push('patch is empty');
  return { paths, reasons };
}

/** Code spans keep scoped names (`@azure/...`) from notifying GitHub users. */
export function renderBody(result, skippedCount = 0) {
  const severityRank = (alert) => SEVERITY_ORDER.indexOf(alert.severity);
  const lines = ['## What and why', ''];
  lines.push(
    `Automated remediation of ${result.resolved.length} open Dependabot alert(s). Only manifests and lockfiles change.`,
    '',
    '| Alert | Severity | Package | Lockfile | Advisory |',
    '|---|---|---|---|---|'
  );
  for (const a of [...result.resolved].sort((l, r) => severityRank(l) - severityRank(r))) {
    lines.push(
      `| #${a.number} | ${a.severity} | \`${a.package}\` | \`${a.manifest}\` | ${a.ghsa} |`
    );
  }
  if (result.upgrades.length > 0) {
    lines.push('', '### Version changes', '');
    for (const u of result.upgrades) {
      lines.push(`- \`${u.name}\` ${u.from} → ${u.to} (\`${u.manifest}\`)`);
    }
  }
  if (result.holds.length > 0) {
    lines.push('', '### Needs a human merge', '', 'Auto-merge was not enabled because:', '');
    for (const hold of result.holds) lines.push(`- ${hold}`);
  }
  if (result.unresolved.length > 0) {
    lines.push('', '### Still open', '');
    for (const a of result.unresolved) {
      lines.push(`- #${a.number} \`${a.package}\` (\`${a.manifest}\`) ${a.ghsa}`);
    }
  }
  if (skippedCount > 0) {
    lines.push('', `${skippedCount} alert(s) were outside this automation's scope.`);
  }
  lines.push(
    '',
    '## How was it tested?',
    '',
    'Policy gate: `scripts/dependabot-remediate.mjs verify`. Merging is gated by the required checks on `main`.',
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    ''
  );
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag?.startsWith('--') || argv[i + 1] === undefined) {
      throw new Error(`Bad argument: ${flag}`);
    }
    args[flag.slice(2)] = argv[i + 1];
  }
  return args;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function setOutput(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  for (const [key, value] of Object.entries(values)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

function runDetect({ repo, out }) {
  const stdout = execFileSync(
    'gh',
    ['api', '--paginate', '--slurp', `/repos/${repo}/dependabot/alerts?state=open&per_page=100`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  const { alerts, skipped } = sanitizeAlerts(JSON.parse(stdout).flat());
  writeFileSync(out, JSON.stringify({ alerts, skipped: skipped.length }, null, 2));
  if (skipped.length > 0) {
    console.log(
      `::warning::${skipped.length} open alert(s) are out of scope: ${skipped.join(', ')}`
    );
  }
  console.log(`${alerts.length} actionable open alert(s).`);
  setOutput({ count: alerts.length, fingerprint: fingerprint(alerts) });
}

function runVerify({ base, patch, alerts: alertsPath, body }) {
  const { alerts, skipped } = JSON.parse(readFileSync(alertsPath, 'utf8'));
  const shape = checkPatchShape(git('apply', '--numstat', patch), git('apply', '--summary', patch));
  /** @type {ReturnType<typeof evaluateChange> | {decision: 'reject', reasons: string[]}} */
  let result;
  if (shape.reasons.length > 0) {
    result = { decision: 'reject', reasons: shape.reasons };
  } else {
    git('apply', patch);
    const lockPaths = ['package-lock.json', 'docs-site/package-lock.json'];
    const locksAfter = Object.fromEntries(
      lockPaths.map((path) => [path, JSON.parse(readFileSync(path, 'utf8'))])
    );
    result = evaluateChange({
      alerts,
      locksAfter,
      files: shape.paths.map((path) => ({
        path,
        before: JSON.parse(git('show', `${base}:${path}`)),
        after: JSON.parse(readFileSync(path, 'utf8')),
      })),
    });
    writeFileSync(body, renderBody(result, skipped));
  }
  console.log(`Decision: ${result.decision}`);
  for (const reason of result.reasons) console.log(`::error::${reason}`);
  for (const hold of result.holds ?? []) console.log(`::warning::${hold}`);
  setOutput({ decision: result.decision });
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === 'detect') return runDetect(args);
  if (command === 'verify') return runVerify(args);
  throw new Error(`Unknown command: ${command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
