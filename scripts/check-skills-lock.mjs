#!/usr/bin/env node
// Imported agent skills are third-party code that runs on contributors'
// machines (epic #1283 → #1298). skills-lock.json records a `computedHash` per
// imported skill; this check fails when a checked-in skill folder no longer
// matches its recorded hash, so a vendored skill can't change without the lock
// changing too. First-party skills are listed separately in
// scripts/first-party-skills.json and are checked for completeness and links.
//
// The hash mirrors the `skills` CLI's computeSkillFolderHash: SHA-256 over
// every file under the skill folder (skipping .git and node_modules), sorted by
// relative POSIX path with String#localeCompare, feeding path then content.
//
// Usage: node scripts/check-skills-lock.mjs
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = '.agents/skills';

function collectFiles(baseDir, currentDir, results) {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      collectFiles(baseDir, fullPath, results);
    } else if (entry.isFile()) {
      results.push({
        relativePath: relative(baseDir, fullPath).split('\\').join('/'),
        content: readFileSync(fullPath),
      });
    }
  }
}

/** Symlinks under a skill folder (relative POSIX paths). The upstream hash
 * skips them (Dirent.isFile/isDirectory are false for links), so a planted
 * link would change what the skill loads without changing its hash. */
function findSymlinks(baseDir, currentDir, results) {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isSymbolicLink()) {
      results.push(relative(baseDir, fullPath).split('\\').join('/'));
    } else if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') {
      findSymlinks(baseDir, fullPath, results);
    }
  }
  return results;
}

export function computeSkillFolderHash(skillDir) {
  const files = [];
  collectFiles(skillDir, skillDir, files);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update(file.content);
  }
  return hash.digest('hex');
}

export function checkSkillsLock(lock, skillsRoot, firstParty = []) {
  const findings = [];
  const locked = lock.skills ?? {};
  const firstPartyNames = new Set(firstParty);
  for (const name of firstPartyNames) {
    const dir = join(skillsRoot, name);
    if (Object.hasOwn(locked, name)) {
      findings.push({ name, problem: 'listed as both imported and first-party' });
      continue;
    }
    if (!existsSync(join(dir, 'SKILL.md'))) {
      findings.push({ name, problem: 'first-party skill is missing SKILL.md' });
      continue;
    }
    for (const link of findSymlinks(dir, dir, []).sort()) {
      findings.push({ name, problem: `contains a symlink: ${link}` });
    }
  }
  for (const [name, entry] of Object.entries(locked)) {
    const dir = join(skillsRoot, name);
    if (!existsSync(dir)) {
      findings.push({ name, problem: 'locked skill folder is missing' });
      continue;
    }
    for (const link of findSymlinks(dir, dir, []).sort()) {
      findings.push({ name, problem: `contains a symlink: ${link}` });
    }
    const actual = computeSkillFolderHash(dir);
    if (actual !== entry.computedHash) {
      findings.push({
        name,
        problem: `hash mismatch (lock ${entry.computedHash}, files ${actual})`,
      });
    }
  }
  if (existsSync(skillsRoot)) {
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        findings.push({ name: entry.name, problem: 'symlink in the skills folder' });
      } else if (
        entry.isDirectory() &&
        !Object.hasOwn(locked, entry.name) &&
        !firstPartyNames.has(entry.name)
      ) {
        findings.push({
          name: entry.name,
          problem: 'skill folder is not recorded in skills-lock.json',
        });
      }
    }
  }
  return findings;
}

function main() {
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'skills-lock.json'), 'utf8'));
  const firstParty = JSON.parse(
    readFileSync(join(REPO_ROOT, 'scripts/first-party-skills.json'), 'utf8')
  ).skills;
  const findings = checkSkillsLock(lock, join(REPO_ROOT, SKILLS_DIR), firstParty);
  for (const f of findings) console.error(`${SKILLS_DIR}/${f.name}: ${f.problem}`);
  if (findings.length > 0) {
    console.error(
      '\nImported skills must match skills-lock.json. Review the upstream diff, then update with the skills CLI' +
        ' (`npx skills update`) so the lock and the files change together.'
    );
    process.exit(1);
  }
  console.log(
    `Skills OK (${Object.keys(lock.skills ?? {}).length} imported, ${firstParty.length} first-party).`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
