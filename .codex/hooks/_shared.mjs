import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';

export function readPayload() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

export function repoRoot(cwd = process.cwd()) {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

export function projectRelative(file, root) {
  if (typeof file !== 'string' || file.length === 0) return null;
  const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)) return null;
  return relative.split(path.sep).join('/');
}

export function extractToolPaths(toolInput, root) {
  const paths = new Set();
  const add = (candidate) => {
    const relative = projectRelative(candidate, root);
    if (relative) paths.add(relative);
  };
  const visit = (value, key = '') => {
    if (typeof value === 'string') {
      if (['file_path', 'path', 'target'].includes(key)) add(value);
      for (const match of value.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
        add(match[1]?.trim());
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  };
  visit(toolInput);
  return [...paths];
}

export function statePath(name, root) {
  return path.resolve(root, '.codex/metrics', name);
}

function gitOutput(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

function gitLines(root, args) {
  return gitOutput(root, args)
    .trimEnd()
    .split('\n')
    .filter((line) => line.length > 0);
}

function nulSeparatedPaths(output) {
  return output.split('\0').filter((entry) => entry.length > 0);
}

function statusPaths(root) {
  const records = nulSeparatedPaths(
    gitOutput(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  );
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    paths.push(record.slice(3));
    if (/[RC]/.test(record.slice(0, 2))) {
      const source = records[index + 1];
      if (source) paths.push(source);
      index += 1;
    }
  }
  return paths;
}

export function parseStatusPath(line) {
  const raw = line.slice(3);
  const file = raw.includes(' -> ') ? raw.split(' -> ').at(-1) : raw;
  return file?.replace(/^"|"$/g, '') ?? null;
}

export function contentFingerprint(file, root) {
  const absolute = path.resolve(root, file);
  if (!existsSync(absolute)) return `${file}:deleted`;
  const stat = lstatSync(absolute);
  const hash = createHash('sha256');
  if (stat.isSymbolicLink()) hash.update(readlinkSync(absolute));
  else if (stat.isFile()) hash.update(readFileSync(absolute));
  else hash.update(`${stat.size}`);
  return `${file}:${stat.mode}:${hash.digest('hex')}`;
}

export function signatureFromDetails(head, details) {
  return createHash('sha256')
    .update([`HEAD:${head}`, ...details].join('\n'))
    .digest('hex');
}

export function treeSignature(root) {
  const [head = 'unknown'] = gitLines(root, ['rev-parse', 'HEAD']);
  let base = null;
  for (const ref of ['origin/main', 'main', 'origin/master', 'master']) {
    const [candidate] = gitLines(root, ['merge-base', 'HEAD', ref]);
    if (candidate) {
      base = candidate;
      break;
    }
  }

  const files = new Set(
    base ? nulSeparatedPaths(gitOutput(root, ['diff', '--name-only', '-z', `${base}...HEAD`])) : []
  );
  for (const file of statusPaths(root)) files.add(file);

  const details = [...files].sort().map((file) => contentFingerprint(file, root));
  return {
    dirty: details.length > 0,
    signature: signatureFromDetails(head, details),
  };
}
