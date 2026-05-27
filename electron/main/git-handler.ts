/**
 * Git-native collections — Electron main-process handler.
 *
 * Read operations:
 *   - git:status   → modified / untracked / staged file lists
 *   - git:log      → recent commits
 *   - git:diff     → unified diff for a single file (HEAD vs working tree)
 *   - git:branch:list → branches + current
 *
 * Local write operations (no remote):
 *   - git:add             → stage files
 *   - git:commit          → commit staged (optionally stage-all first)
 *   - git:branch:create   → create + switch to a branch
 *   - git:branch:checkout → switch branch (triggers a collection reload via the
 *                           file watcher)
 *
 * Deferred: remote fetch/push/pull — needs a credential model (SSH key vs
 * HTTPS token + SecretRef), a bigger conversation.
 *
 * Security:
 *  - Directory paths are validated against a whitelist (provided by the
 *    caller via the registration argument — typically backed by
 *    `useFileCollectionStore`). A handler call against an arbitrary dir is
 *    rejected.
 *  - We use `execFile` (NOT `exec`) — no shell parsing, no injection vector.
 *  - Branch and ref names are sanitized via a strict regex before being
 *    passed as arguments.
 *  - Output size is capped at MAX_OUTPUT_BYTES per call.
 *  - Concurrent calls per directory are serialised via a per-dir mutex to
 *    keep `git index` consistent under high-frequency polling.
 *
 * If `git` is not installed on PATH, every call returns a clear error —
 * we never silently no-op. Detection is best-effort and cached after the
 * first call.
 */

import { execFile } from 'child_process';
import { ipcMain } from 'electron';
import { IPC } from '../shared/channels';
import { promisify } from 'util';
import * as path from 'path';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2MB per command output
const COMMAND_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Whitelist — only operate against directories the renderer has registered.
// ---------------------------------------------------------------------------

let isDirectoryAllowed: (dirPath: string) => boolean = () => false;

/**
 * Configure the directory-allowlist predicate. The Electron app should call
 * this with a checker that consults `useFileCollectionStore` so only
 * registered file-backed collections can be git-driven.
 */
export function setGitDirectoryAllowlist(check: (dirPath: string) => boolean): void {
  isDirectoryAllowed = check;
}

function ensureDirectoryAllowed(rawPath: string): string {
  const absolute = path.resolve(rawPath);
  if (!isDirectoryAllowed(absolute)) {
    throw new GitError(
      `Directory not allowed: ${absolute} is not registered as a file-backed collection`,
      'forbidden'
    );
  }
  return absolute;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const DirectoryInputSchema = z.object({
  directoryPath: z.string().min(1).max(2048),
});
const DiffInputSchema = DirectoryInputSchema.extend({
  filePath: z.string().min(1).max(2048),
});
const LogInputSchema = DirectoryInputSchema.extend({
  limit: z.number().int().min(1).max(500).optional(),
});
const AddFilesInputSchema = DirectoryInputSchema.extend({
  filePaths: z.array(z.string().min(1).max(2048)).min(1).max(1000),
});
const CommitInputSchema = DirectoryInputSchema.extend({
  message: z.string().min(1).max(5000),
  all: z.boolean().optional(),
  paths: z.array(z.string().min(1).max(2048)).max(1000).optional(),
});
const RefInputSchema = DirectoryInputSchema.extend({
  name: z.string().min(1).max(255),
});

/**
 * Allow only characters that git refs reliably accept. This is conservative —
 * it rejects perfectly valid refs that contain weird-but-allowed glyphs.
 * Callers should not pass user-typed branch names through this directly.
 */
const REF_NAME_RE = /^[A-Za-z0-9._\-/]{1,255}$/;
function sanitiseRefName(name: string): string {
  if (!REF_NAME_RE.test(name)) {
    throw new GitError(`Invalid ref name: ${name}`, 'invalid-input');
  }
  // Per git's check-ref-format rules, no leading dash, no `..`, no `@{`, no `:`
  if (name.startsWith('-') || name.includes('..') || name.includes('@{') || name.includes(':')) {
    throw new GitError(`Invalid ref name: ${name}`, 'invalid-input');
  }
  return name;
}

// ---------------------------------------------------------------------------
// Pure parsers — extracted so unit tests can cover them without `git`.
// ---------------------------------------------------------------------------

export interface GitStatusFile {
  path: string;
  /** Index status code from `git status --porcelain` (e.g. 'M', 'A', 'D', '?'). */
  staged: string;
  unstaged: string;
}

export interface GitStatus {
  files: GitStatusFile[];
  branch: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
}

export interface GitCommit {
  sha: string;
  abbreviatedSha: string;
  author: string;
  email: string;
  timestamp: number;
  subject: string;
}

export interface GitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream?: string;
}

export function parsePorcelainV2(raw: string): GitStatus {
  const files: GitStatusFile[] = [];
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;

  for (const line of raw.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const name = line.slice('# branch.head '.length).trim();
      branch = name === '(detached)' ? null : name;
    } else if (line.startsWith('# branch.ab ')) {
      const parts = line.slice('# branch.ab '.length).trim().split(' ');
      ahead = Number((parts[0] ?? '+0').replace(/[+-]/g, '')) || 0;
      behind = Number((parts[1] ?? '-0').replace(/[+-]/g, '')) || 0;
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <newPath>\t<origPath>
      const xy = line.split(' ')[1] ?? '..';
      const isRename = line.startsWith('2 ');
      // Rename: the CURRENT (new) path is before the tab, after the rename-score
      // field (index 9). Ordinary change: path is field 8 onward.
      const beforeTab = line.split('\t')[0] ?? '';
      const filePath = isRename
        ? beforeTab.split(' ').slice(9).join(' ')
        : line.split(' ').slice(8).join(' ');
      if (filePath) {
        files.push({
          path: filePath,
          staged: xy.charAt(0),
          unstaged: xy.charAt(1),
        });
      }
    } else if (line.startsWith('? ')) {
      files.push({ path: line.slice(2), staged: '?', unstaged: '?' });
    } else if (line.startsWith('! ')) {
      // ignored — not surfaced
    }
  }

  return { files, branch, ahead, behind, clean: files.length === 0 };
}

/**
 * Parse `git log --pretty=format:%H%x01%h%x01%an%x01%ae%x01%at%x01%s`.
 * The 0x01 SOH byte separator is highly unlikely to appear in real commit
 * subjects, making this resilient to commit-message punctuation.
 *
 * Malformed lines are skipped, but the count of skipped lines is emitted as
 * a single `console.warn` so anyone debugging git-native collections can see
 * whether the parser is silently dropping data.
 */
export function parseCommitLog(raw: string): GitCommit[] {
  const out: GitCommit[] = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [sha, abbr, author, email, ts, subject] = line.split('\x01');
    if (!sha || !abbr || !ts) {
      skipped += 1;
      continue;
    }
    out.push({
      sha,
      abbreviatedSha: abbr,
      author: author ?? '',
      email: email ?? '',
      timestamp: Number(ts) * 1000,
      subject: subject ?? '',
    });
  }
  if (skipped > 0) {
    console.warn(
      `[restura] parseCommitLog: skipped ${skipped} malformed line(s) — git log format may have changed.`
    );
  }
  return out;
}

/**
 * Parse `git branch --list --all --format='%(refname:short)\t%(upstream:short)'`
 * preceded by HEAD detection via a separate `--show-current` call.
 */
export function parseBranchList(raw: string, currentBranch: string | null): GitBranch[] {
  const out: GitBranch[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [refRaw, upstreamRaw] = line.split('\t');
    const ref = refRaw?.trim();
    if (!ref) continue;
    const isRemote = ref.startsWith('remotes/');
    const name = isRemote ? ref.replace(/^remotes\//, '') : ref;
    out.push({
      name,
      isCurrent: !isRemote && currentBranch !== null && name === currentBranch,
      isRemote,
      ...(upstreamRaw && upstreamRaw.trim() ? { upstream: upstreamRaw.trim() } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-directory mutex
// ---------------------------------------------------------------------------

const dirLocks = new Map<string, Promise<unknown>>();

function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = dirLocks.get(dir) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  dirLocks.set(
    dir,
    next.finally(() => {
      if (dirLocks.get(dir) === next) dirLocks.delete(dir);
    })
  );
  return next;
}

// ---------------------------------------------------------------------------
// Git binary invocation
// ---------------------------------------------------------------------------

export class GitError extends Error {
  constructor(message: string, public readonly code: string = 'error') {
    super(message);
    this.name = 'GitError';
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: COMMAND_TIMEOUT_MS,
      // Force UTF-8 + no pager.
      env: { ...process.env, LANG: 'C.UTF-8', GIT_PAGER: 'cat', PAGER: 'cat' },
    });
    return stdout;
  } catch (err) {
    if (err && typeof err === 'object') {
      const e = err as { code?: string; stderr?: string; message?: string };
      if (e.code === 'ENOENT') {
        throw new GitError(
          'git is not installed or not on PATH. Install git to use git-native collections.',
          'git-missing'
        );
      }
      throw new GitError(e.stderr?.trim() || e.message || 'git command failed', 'git-error');
    }
    throw new GitError(String(err), 'git-error');
  }
}

// ---------------------------------------------------------------------------
// Public command surface
// ---------------------------------------------------------------------------

export async function gitStatus(directoryPath: string): Promise<GitStatus> {
  const dir = ensureDirectoryAllowed(directoryPath);
  return withLock(dir, async () => {
    const raw = await runGit(dir, ['status', '--porcelain=v2', '--branch']);
    return parsePorcelainV2(raw);
  });
}

export async function gitLog(directoryPath: string, limit = 50): Promise<GitCommit[]> {
  const dir = ensureDirectoryAllowed(directoryPath);
  return withLock(dir, async () => {
    const raw = await runGit(dir, [
      'log',
      `-n${limit}`,
      '--pretty=format:%H%x01%h%x01%an%x01%ae%x01%at%x01%s',
    ]);
    return parseCommitLog(raw);
  });
}

export async function gitDiff(directoryPath: string, filePath: string): Promise<string> {
  const dir = ensureDirectoryAllowed(directoryPath);
  // Path is restricted to within the directory — no escapes.
  const abs = path.resolve(dir, filePath);
  if (!abs.startsWith(dir + path.sep) && abs !== dir) {
    throw new GitError(`File path escapes the collection directory: ${filePath}`, 'invalid-input');
  }
  return withLock(dir, async () => {
    const raw = await runGit(dir, ['diff', '--no-color', '--', filePath]);
    return raw;
  });
}

export async function gitBranchList(directoryPath: string): Promise<GitBranch[]> {
  const dir = ensureDirectoryAllowed(directoryPath);
  return withLock(dir, async () => {
    const [current, list] = await Promise.all([
      runGit(dir, ['branch', '--show-current']).then((s) => s.trim() || null),
      runGit(dir, [
        'branch',
        '--list',
        '--all',
        '--format=%(refname:short)\t%(upstream:short)',
      ]),
    ]);
    return parseBranchList(list, current);
  });
}

// ---------------------------------------------------------------------------
// Write operations (local only — no remote/push/pull; that needs a credential
// model and lands in a later milestone). All reuse the allowlist + per-dir lock.
// ---------------------------------------------------------------------------

/** Resolve a file path and assert it stays within the collection directory. */
function resolveWithin(dir: string, filePath: string): string {
  const abs = path.resolve(dir, filePath);
  if (!abs.startsWith(dir + path.sep) && abs !== dir) {
    throw new GitError(`File path escapes the collection directory: ${filePath}`, 'invalid-input');
  }
  return abs;
}

export async function gitAddFiles(directoryPath: string, filePaths: string[]): Promise<true> {
  const dir = ensureDirectoryAllowed(directoryPath);
  // Validate every path before touching the index.
  for (const fp of filePaths) resolveWithin(dir, fp);
  return withLock(dir, async () => {
    // `--` terminates option parsing so a path can't be read as a flag.
    await runGit(dir, ['add', '--', ...filePaths]);
    return true as const;
  });
}

/**
 * Commit staged changes (optionally staging everything first). Returns the new
 * commit's full + abbreviated SHA. Fails clearly when there's nothing to commit
 * or when git identity (user.name/email) isn't configured — we never set it.
 */
export async function gitCommit(
  directoryPath: string,
  message: string,
  options: { all?: boolean; paths?: string[] } = {}
): Promise<{ sha: string; abbreviatedSha: string }> {
  const dir = ensureDirectoryAllowed(directoryPath);
  if (options.paths) for (const p of options.paths) resolveWithin(dir, p);
  return withLock(dir, async () => {
    if (options.all) await runGit(dir, ['add', '-A']);
    // message passed as a single execFile arg — no shell, no injection.
    // When `paths` are given, scope the commit to exactly those (git's --only
    // semantics) so content staged outside this UI isn't swept in.
    const args = ['commit', '-m', message];
    if (options.paths && options.paths.length > 0) args.push('--', ...options.paths);
    await runGit(dir, args);
    const sha = (await runGit(dir, ['rev-parse', 'HEAD'])).trim();
    return { sha, abbreviatedSha: sha.slice(0, 7) };
  });
}

export async function gitCreateBranch(directoryPath: string, name: string): Promise<string> {
  const dir = ensureDirectoryAllowed(directoryPath);
  const ref = sanitiseRefName(name);
  return withLock(dir, async () => {
    // Create and switch in one step.
    await runGit(dir, ['checkout', '-b', ref]);
    return ref;
  });
}

export async function gitCheckoutBranch(directoryPath: string, name: string): Promise<string> {
  const dir = ensureDirectoryAllowed(directoryPath);
  const ref = sanitiseRefName(name);
  return withLock(dir, async () => {
    // Switching branches rewrites files on disk; the collection-manager file
    // watcher (chokidar) picks the change up and reloads the collection.
    await runGit(dir, ['checkout', ref]);
    return ref;
  });
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

/**
 * Builds an `ipcMain.handle` callback that parses input through `schema`,
 * invokes `run`, and packages the response under `resultKey`. Errors are
 * normalised to `{ ok: false, error }`. Used by every git IPC handler so
 * the parse-then-try-catch boilerplate exists once.
 */
function ipcCommand<T, R>(
  schema: z.ZodType<T>,
  resultKey: string,
  run: (data: T) => Promise<R>
): (_e: unknown, payload: unknown) => Promise<Record<string, unknown>> {
  return async (_e, payload) => {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    try {
      return { ok: true, [resultKey]: await run(parsed.data) };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  };
}

export function registerGitHandlerIPC(): void {
  ipcMain.handle(
    IPC.git.status,
    ipcCommand(DirectoryInputSchema, 'status', ({ directoryPath }) => gitStatus(directoryPath))
  );
  ipcMain.handle(
    IPC.git.log,
    ipcCommand(LogInputSchema, 'commits', ({ directoryPath, limit }) =>
      gitLog(directoryPath, limit ?? 50)
    )
  );
  ipcMain.handle(
    IPC.git.diff,
    ipcCommand(DiffInputSchema, 'diff', ({ directoryPath, filePath }) =>
      gitDiff(directoryPath, filePath)
    )
  );
  ipcMain.handle(
    IPC.git.branchList,
    ipcCommand(DirectoryInputSchema, 'branches', ({ directoryPath }) =>
      gitBranchList(directoryPath)
    )
  );
  ipcMain.handle(
    IPC.git.add,
    ipcCommand(AddFilesInputSchema, 'staged', ({ directoryPath, filePaths }) =>
      gitAddFiles(directoryPath, filePaths)
    )
  );
  ipcMain.handle(
    IPC.git.commit,
    ipcCommand(CommitInputSchema, 'commit', ({ directoryPath, message, all, paths }) =>
      gitCommit(directoryPath, message, {
        ...(all !== undefined ? { all } : {}),
        ...(paths !== undefined ? { paths } : {}),
      })
    )
  );
  ipcMain.handle(
    IPC.git.createBranch,
    ipcCommand(RefInputSchema, 'branch', ({ directoryPath, name }) =>
      gitCreateBranch(directoryPath, name)
    )
  );
  ipcMain.handle(
    IPC.git.checkoutBranch,
    ipcCommand(RefInputSchema, 'branch', ({ directoryPath, name }) =>
      gitCheckoutBranch(directoryPath, name)
    )
  );
}

export function unregisterGitHandlerIPC(): void {
  ipcMain.removeHandler(IPC.git.status);
  ipcMain.removeHandler(IPC.git.log);
  ipcMain.removeHandler(IPC.git.diff);
  ipcMain.removeHandler(IPC.git.branchList);
  ipcMain.removeHandler(IPC.git.add);
  ipcMain.removeHandler(IPC.git.commit);
  ipcMain.removeHandler(IPC.git.createBranch);
  ipcMain.removeHandler(IPC.git.checkoutBranch);
}

function errorMessage(err: unknown): string {
  if (err instanceof GitError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

// Surface the sanitiser so tests can exercise it without a real git repo.
export { sanitiseRefName };
