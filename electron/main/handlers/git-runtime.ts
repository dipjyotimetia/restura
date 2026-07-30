import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;
const REMOTE_COMMAND_TIMEOUT_MS = 60_000;

let isDirectoryAllowed: (dirPath: string) => boolean = () => false;

export function setGitDirectoryAllowlist(check: (dirPath: string) => boolean): void {
  isDirectoryAllowed = check;
}

export function ensureDirectoryAllowed(rawPath: string): string {
  const absolute = path.resolve(rawPath);
  if (!isDirectoryAllowed(absolute)) {
    throw new GitError(
      `Directory not allowed: ${absolute} is not registered as a file-backed collection`,
      'forbidden'
    );
  }
  return absolute;
}

export class GitError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'error'
  ) {
    super(message);
    this.name = 'GitError';
  }
}

const REF_NAME_RE = /^[A-Za-z0-9._\-/]{1,255}$/;

export function sanitiseRefName(name: string): string {
  if (
    !REF_NAME_RE.test(name) ||
    name.startsWith('-') ||
    name.includes('..') ||
    name.includes('@{') ||
    name.includes(':')
  ) {
    throw new GitError(`Invalid ref name: ${name}`, 'invalid-input');
  }
  return name;
}

const SCP_STYLE_GIT_URL = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+(?:\.git)?$/;

export function sanitiseRemoteUrl(value: string): string {
  const remoteUrl = value.trim();
  if (SCP_STYLE_GIT_URL.test(remoteUrl)) return remoteUrl;
  try {
    const url = new URL(remoteUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'ssh:') {
      throw new GitError('Remote URL must use HTTPS or SSH.', 'invalid-remote-url');
    }
    if (!url.hostname || url.password || (url.username && url.protocol === 'https:')) {
      throw new GitError('Remote URL must not contain credentials.', 'invalid-remote-url');
    }
    return remoteUrl;
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError('Remote URL must be a valid HTTPS or SSH Git URL.', 'invalid-remote-url');
  }
}

export function sanitiseCloneDirectoryName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(name) || name === '.' || name === '..') {
    throw new GitError('Choose a simple folder name for the cloned workspace.', 'invalid-input');
  }
  return name;
}

const dirLocks = new Map<string, Promise<unknown>>();

export function withGitLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = dirLocks.get(dir) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  dirLocks.set(dir, next);
  void next
    .catch(() => undefined)
    .finally(() => {
      if (dirLocks.get(dir) === next) dirLocks.delete(dir);
    });
  return next;
}

export async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const safeEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
    );
    const { stdout } = await execFileAsync(
      'git',
      ['-c', 'core.fsmonitor=', '-c', 'core.sshCommand=', ...args],
      {
        cwd,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: ['clone', 'fetch', 'push'].includes(args[0] ?? '')
          ? REMOTE_COMMAND_TIMEOUT_MS
          : COMMAND_TIMEOUT_MS,
        env: {
          ...safeEnv,
          LANG: 'C.UTF-8',
          GIT_PAGER: 'cat',
          PAGER: 'cat',
          GIT_ALLOW_PROTOCOL: 'https:ssh',
          GIT_LITERAL_PATHSPECS: '1',
        },
      }
    );
    return stdout;
  } catch (error) {
    throw normaliseGitError(error, cwd);
  }
}

export function resolveWithin(dir: string, filePath: string): string {
  const absolute = path.resolve(dir, filePath);
  if (!absolute.startsWith(`${dir}${path.sep}`) && absolute !== dir) {
    throw new GitError(`File path escapes the collection directory: ${filePath}`, 'invalid-input');
  }
  return absolute;
}

function normaliseGitError(error: unknown, cwd: string): GitError {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: string; stderr?: string; message?: string };
    if (candidate.code === 'ENOENT') {
      if (!existsSync(cwd)) {
        return new GitError(
          'Collection directory no longer exists. Re-open it to continue.',
          'directory-missing'
        );
      }
      return new GitError(
        'git is not installed or not on PATH. Install git to use git-native collections.',
        'git-missing'
      );
    }
    const message = candidate.stderr?.trim() || candidate.message || 'git command failed';
    if (/not a git repository/i.test(message)) return new GitError(message, 'not-a-repo');
    return new GitError(message, 'git-error');
  }
  return new GitError(String(error), 'git-error');
}
