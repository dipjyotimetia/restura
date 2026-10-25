// Forbidden deploy-config keys: a key that must never be set in a checked-in
// config file (e.g. `DEV_BYPASS_AUTH` in wrangler.jsonc, which would disable
// Worker auth in production). Comments are ignored so a file may document the
// rule; any JSON property with the key — at any depth — is a hard violation.
import fs from 'node:fs';
import path from 'node:path';
import type { ArchitectureViolation } from './architecture-policy.mts';

export interface ForbiddenConfigKey {
  key: string;
  /** Regular-expression source matched against repo-relative POSIX paths. */
  filePattern: string;
  /** Why the key is forbidden and where it belongs instead. */
  reason: string;
}

export interface ConfigFile {
  path: string;
  text: string;
}

/** Remove `//` and `/* *\/` comments from JSONC, leaving string contents intact. */
export function stripJsonComments(text: string): string {
  let output = '';
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    const next = text[index + 1];
    if (inString) {
      output += char;
      if (char === '\\') {
        output += next ?? '';
        index++;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index++;
      output += '\n';
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      const comment = text.slice(index, end === -1 ? text.length : end + 2);
      output += comment.replace(/[^\n]/g, ' ');
      index = end === -1 ? text.length : end + 1;
    } else output += char;
  }
  return output;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function evaluateForbiddenConfigKeys(
  files: ConfigFile[],
  rules: ForbiddenConfigKey[]
): ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const code = stripJsonComments(file.text);
    for (const rule of rules) {
      if (!new RegExp(rule.filePattern).test(file.path)) continue;
      const property = new RegExp(`"${escapeRegExp(rule.key)}"\\s*:`, 'g');
      for (const match of code.matchAll(property)) {
        const line = code.slice(0, match.index).split('\n').length;
        violations.push({
          rule: 'forbidden-config-key',
          file: `${file.path}:${line}`,
          message: `${file.path}:${line} sets ${rule.key}: ${rule.reason}`,
        });
      }
    }
  }
  return violations;
}

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.claude',
  '.wrangler',
  'dist',
  'out',
  'coverage',
  'release',
]);

/** Config files under `root` (depth-limited) matching any rule's file pattern. */
export function scanConfigFiles(
  root: string,
  rules: ForbiddenConfigKey[],
  maxDepth = 3
): ConfigFile[] {
  const patterns = rules.map((rule) => new RegExp(rule.filePattern));
  const files: ConfigFile[] = [];
  const visit = (directory: string, depth: number): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) visit(absolute, depth + 1);
        continue;
      }
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (patterns.some((pattern) => pattern.test(relative))) {
        files.push({ path: relative, text: fs.readFileSync(absolute, 'utf8') });
      }
    }
  };
  visit(root, 0);
  return files;
}
