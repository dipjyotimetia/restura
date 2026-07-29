import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const exceptions = JSON.parse(
  readFileSync(new URL('../security/dependency-audit-exceptions.json', import.meta.url), 'utf8')
);
const now = new Date();
const allowedAdvisories = new Set();

for (const exception of exceptions.exceptions) {
  if (
    !exception.id ||
    !exception.owner ||
    !exception.rationale ||
    !exception.reachability ||
    !exception.created ||
    !exception.expires
  ) {
    throw new Error(
      'Every dependency-audit exception needs id, owner, rationale, reachability, created, and expires'
    );
  }
  const created = new Date(`${exception.created}T00:00:00Z`);
  const expiry = new Date(`${exception.expires}T00:00:00Z`);
  if (!Number.isFinite(created.valueOf()) || !Number.isFinite(expiry.valueOf()) || expiry < now) {
    throw new Error(`Dependency-audit exception ${exception.id} expired on ${exception.expires}`);
  }
  if (expiry.valueOf() - created.valueOf() > 90 * 24 * 60 * 60 * 1000) {
    throw new Error(`Dependency-audit exception ${exception.id} exceeds the 90-day maximum`);
  }
  for (const advisory of exception.advisories) allowedAdvisories.add(advisory);
}

const audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
if (!audit.stdout) {
  throw new Error(audit.stderr || 'npm audit returned no JSON report');
}
const report = JSON.parse(audit.stdout);
const vulnerabilities = report.vulnerabilities ?? {};
const covered = new Map();

function isCovered(name, visiting = new Set()) {
  if (covered.has(name)) return covered.get(name);
  if (visiting.has(name)) return false;
  visiting.add(name);
  const vulnerability = vulnerabilities[name];
  const result =
    vulnerability?.via.length > 0 &&
    vulnerability.via.every((via) =>
      typeof via === 'string'
        ? isCovered(via, visiting)
        : allowedAdvisories.has(via.url) || allowedAdvisories.has(String(via.source))
    );
  visiting.delete(name);
  covered.set(name, result);
  return result;
}

const blocking = Object.entries(vulnerabilities)
  .filter(([, vulnerability]) => ['high', 'critical'].includes(vulnerability.severity))
  .filter(([name]) => !isCovered(name))
  .map(([name, vulnerability]) => `${name} (${vulnerability.severity})`);

if (blocking.length > 0) {
  console.error(`Unapproved high/critical production advisories:\n- ${blocking.join('\n- ')}`);
  process.exit(1);
}

console.log('No unapproved high/critical production dependency advisories.');
