// Forbidden deploy-config keys: a key that must never be set in a checked-in
// config file (e.g. `DEV_BYPASS_AUTH` in wrangler.jsonc/toml, which would
// disable Worker auth in production). Comments and string values are ignored
// so a file may document the rule; the key used as a property (JSON/JSON5
// `key:` quoted or not, TOML `key =`) at any depth is a hard violation. A rule
// whose file pattern matches nothing fails closed.
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

interface ConfigToken {
  kind: 'string' | 'word' | 'punct';
  value: string;
  line: number;
}

/**
 * Minimal JSON/JSONC/JSON5/TOML tokenizer: drops comments (`//`, `/* *\/`,
 * and `#` for TOML), keeps string contents as single tokens (so a key name
 * mentioned inside a value or a comment is never mistaken for a key).
 */
export function tokenizeConfig(text: string, toml: boolean): ConfigToken[] {
  const tokens: ConfigToken[] = [];
  let line = 1;
  let index = 0;
  const advanceTo = (end: number) => {
    for (let i = index; i < end; i++) if (text[i] === '\n') line++;
    index = end;
  };
  while (index < text.length) {
    const char = text[index]!;
    const rest = text.slice(index, index + 3);
    if (/\s/.test(char)) advanceTo(index + 1);
    else if ((toml && char === '#') || (!toml && rest.startsWith('//'))) {
      const end = text.indexOf('\n', index);
      advanceTo(end === -1 ? text.length : end);
    } else if (!toml && rest.startsWith('/*')) {
      const end = text.indexOf('*/', index + 2);
      advanceTo(end === -1 ? text.length : end + 2);
    } else if (toml && (rest === '"""' || rest === "'''")) {
      const end = text.indexOf(rest, index + 3);
      const close = end === -1 ? text.length : end;
      tokens.push({ kind: 'string', value: text.slice(index + 3, close), line });
      advanceTo(Math.min(close + 3, text.length));
    } else if (char === '"' || char === "'") {
      let end = index + 1;
      let value = '';
      while (end < text.length && text[end] !== char) {
        if (text[end] === '\\' && !(toml && char === "'")) end++;
        value += text[end] ?? '';
        end++;
      }
      tokens.push({ kind: 'string', value, line });
      advanceTo(Math.min(end + 1, text.length));
    } else if (/[\w$.+-]/.test(char)) {
      let end = index;
      while (end < text.length && /[\w$.+-]/.test(text[end]!)) end++;
      tokens.push({ kind: 'word', value: text.slice(index, end), line });
      advanceTo(end);
    } else {
      tokens.push({ kind: 'punct', value: char, line });
      advanceTo(index + 1);
    }
  }
  return tokens;
}

function isKeyToken(token: ConfigToken, key: string): boolean {
  if (token.kind === 'string') return token.value === key;
  // TOML dotted keys: `vars.DEV_BYPASS_AUTH = ...`.
  return token.kind === 'word' && (token.value === key || token.value.endsWith(`.${key}`));
}

export function evaluateForbiddenConfigKeys(
  files: ConfigFile[],
  rules: ForbiddenConfigKey[]
): ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = [];
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const rule of rules) {
    const pattern = new RegExp(rule.filePattern);
    const matching = sorted.filter((file) => pattern.test(file.path));
    if (matching.length === 0) {
      violations.push({
        rule: 'forbidden-config-key',
        file: 'scripts/architecture.config.mts',
        message: `No config file matches /${rule.filePattern}/, so the ${rule.key} guard would pass vacuously. If the config moved or was renamed, update forbiddenConfigKeys.filePattern in scripts/architecture.config.mts`,
      });
      continue;
    }
    for (const file of matching) {
      const tokens = tokenizeConfig(file.text, file.path.endsWith('.toml'));
      tokens.forEach((token, at) => {
        const next = tokens[at + 1];
        if (!isKeyToken(token, rule.key) || next?.kind !== 'punct') return;
        if (next.value !== ':' && next.value !== '=') return;
        violations.push({
          rule: 'forbidden-config-key',
          file: `${file.path}:${token.line}`,
          message: `${file.path}:${token.line} sets ${rule.key}: ${rule.reason}`,
        });
      });
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
