import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
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

export function gitPath(name, root) {
  const value = execFileSync('git', ['rev-parse', '--git-path', name], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function gitLines(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trimEnd()
      .split('\n')
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

export function parseStatusPath(line) {
  const raw = line.slice(3);
  const file = raw.includes(' -> ') ? raw.split(' -> ').at(-1) : raw;
  return file?.replace(/^"|"$/g, '') ?? null;
}

export function treeSignature(root) {
  let base = null;
  for (const ref of ['origin/main', 'main', 'origin/master', 'master']) {
    const [candidate] = gitLines(root, ['merge-base', 'HEAD', ref]);
    if (candidate) {
      base = candidate;
      break;
    }
  }

  const files = new Set(base ? gitLines(root, ['diff', '--name-only', `${base}...HEAD`]) : []);
  for (const line of gitLines(root, ['status', '--porcelain=v1'])) {
    const file = parseStatusPath(line);
    if (file) files.add(file);
  }

  const details = [...files].sort().map((file) => {
    const absolute = path.resolve(root, file);
    if (!existsSync(absolute)) return `${file}:deleted`;
    const stat = lstatSync(absolute);
    return `${file}:${stat.size}:${stat.mtimeMs}`;
  });
  return {
    dirty: details.length > 0,
    signature: createHash('sha256').update(details.join('\n')).digest('hex'),
  };
}
