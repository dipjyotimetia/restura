/**
 * Git-native collections — Electron main-process handler.
 *
 * Read operations:
 *   - git:status   → modified / untracked / staged file lists
 *   - git:log      → recent commits
 *   - git:diff     → unified diff for a single file (working tree vs index, i.e.
 *                    unstaged changes)
 *   - git:branch:list → branches + current
 *
 * Local write operations (no remote):
 *   - git:init            → initialise a repo in a registered collection dir
 *   - git:add             → stage files
 *   - git:commit          → commit staged (optionally stage-all first)
 *   - git:branch:create   → create + switch to a branch
 *   - git:branch:checkout → switch branch. The renderer reloads the collection
 *                           from disk afterwards (see useGit.checkout) — the
 *                           file watcher is best-effort and not relied upon.
 *
 * Deferred: remote fetch/push/pull/clone — needs a credential model (SSH key vs
 * HTTPS token + SecretRef), a bigger conversation.
 *
 * Hardening: every invocation neutralises repo-local `core.fsmonitor`
 * (`-c core.fsmonitor=`) so merely opening a hostile repo can't run an
 * attacker-supplied program during the auto-polled `git status`; `git diff`
 * additionally passes `--no-ext-diff --no-textconv`. Repo hooks are deliberately
 * NOT disabled — a user committing to their own repo expects their
 * pre-commit/commit-msg hooks (secret scanners, linters) to run.
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
import { existsSync } from 'fs';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/channels';
import { assertTrustedSender } from '../ipc/ipc-validators';
import { promisify } from 'util';
import * as path from 'path';
import { z } from 'zod';
import { createLogger } from '../../../src/lib/shared/logger';

const log = createLogger('git');

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
 * a single `log.warn` so anyone debugging git-native collections can see
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
    log.warn('parseCommitLog skipped malformed lines — git log format may have changed', {
      skipped,
    });
  }
  return out;
}

/**
 * Parse `git branch --list --all --format='%(refname)\t%(upstream:short)'`
 * preceded by HEAD detection via a separate `--show-current` call.
 *
 * We use the FULL refname (`refs/heads/x`, `refs/remotes/origin/x`) rather than
 * `%(refname:short)` because the short form is the only signal of remoteness and
 * it is ambiguous: `git branch --all` emits a remote `origin/main` as the bare
 * `origin/main`, indistinguishable from a (legal) local branch literally named
 * `origin/main`. With the full refname, `refs/remotes/` is an unambiguous remote
 * marker. The symbolic `refs/remotes/<remote>/HEAD` pointer is dropped — it's not
 * a checkout target, and surfacing it produced a phantom bare `origin` entry.
 */
export function parseBranchList(raw: string, currentBranch: string | null): GitBranch[] {
  const out: GitBranch[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [refRaw, upstreamRaw] = line.split('\t');
    const ref = refRaw?.trim();
    if (!ref) continue;

    let name: string;
    let isRemote: boolean;
    if (ref.startsWith('refs/remotes/')) {
      isRemote = true;
      name = ref.slice('refs/remotes/'.length);
      // Skip the symbolic `<remote>/HEAD` pointer (e.g. refs/remotes/origin/HEAD).
      if (name.endsWith('/HEAD')) continue;
    } else if (ref.startsWith('refs/heads/')) {
      isRemote = false;
      name = ref.slice('refs/heads/'.length);
    } else {
      // Defensive: an unexpected ref category (tags shouldn't appear under
      // `branch --all`). Treat as a local-ish ref keyed on its raw name.
      isRemote = false;
      name = ref;
    }

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
  // Store `next` itself as the lock head so the self-clean below can identity-
  // match it. (Storing `next.finally(...)` — a distinct promise — made the
  // `=== next` check always false, so the entry was never evicted and one
  // settled promise leaked per directory.)
  dirLocks.set(dir, next);
  void next
    .catch(() => undefined)
    .finally(() => {
      // Only the most-recent op clears the entry; if a newer op already
      // replaced the head, leave it for that op to clean up.
      if (dirLocks.get(dir) === next) dirLocks.delete(dir);
    });
  return next;
}

// ---------------------------------------------------------------------------
// Git binary invocation
// ---------------------------------------------------------------------------

export class GitError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'error'
  ) {
    super(message);
    this.name = 'GitError';
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      // `-c core.fsmonitor=` (before the subcommand) neutralises a repo-local
      // `core.fsmonitor = <program>`, which git would otherwise execute during
      // `git status` — the auto-polled, zero-interaction path. Empirically the
      // empty value disables both the program and boolean forms (git 2.x).
      ['-c', 'core.fsmonitor=', ...args],
      {
        cwd,
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: COMMAND_TIMEOUT_MS,
        // Force UTF-8 + no pager.
        env: { ...process.env, LANG: 'C.UTF-8', GIT_PAGER: 'cat', PAGER: 'cat' },
      }
    );
    return stdout;
  } catch (err) {
    if (err && typeof err === 'object') {
      const e = err as { code?: string; stderr?: string; message?: string };
      if (e.code === 'ENOENT') {
        // ENOENT is ambiguous: a missing `git` binary AND a missing `cwd` both
        // surface it. Disambiguate so a deleted/unmounted collection directory
        // doesn't masquerade as "git is not installed".
        if (!existsSync(cwd)) {
          throw new GitError(
            'Collection directory no longer exists. Re-open it to continue.',
            'directory-missing'
          );
        }
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
    // --no-ext-diff / --no-textconv stop a repo-local `.gitattributes` from
    // routing the diff through an attacker-supplied external program.
    const raw = await runGit(dir, [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--',
      filePath,
    ]);
    return raw;
  });
}

export async function gitBranchList(directoryPath: string): Promise<GitBranch[]> {
  const dir = ensureDirectoryAllowed(directoryPath);
  return withLock(dir, async () => {
    const [current, list] = await Promise.all([
      runGit(dir, ['branch', '--show-current']).then((s) => s.trim() || null),
      runGit(dir, ['branch', '--list', '--all', '--format=%(refname)\t%(upstream:short)']),
    ]);
    return parseBranchList(list, current);
  });
}

// ---------------------------------------------------------------------------
// Write operations (local only — no remote/push/pull; that needs a credential
// model and lands in a later milestone). All reuse the allowlist + per-dir lock.
// ---------------------------------------------------------------------------

/**
 * Initialise a git repository in a registered collection directory. Idempotent —
 * `git init` on an existing repo simply re-initialises it. This is the local
 * "spinup" path: a file-backed collection created in a plain directory becomes
 * git-backed without leaving the app. Remote `clone` stays deferred (credentials).
 */
export async function gitInit(directoryPath: string): Promise<true> {
  const dir = ensureDirectoryAllowed(directoryPath);
  return withLock(dir, async () => {
    await runGit(dir, ['init']);
    return true as const;
  });
}

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
): (e: Electron.IpcMainInvokeEvent, payload: unknown) => Promise<Record<string, unknown>> {
  return async (e, payload) => {
    // Defense-in-depth: reject IPC from any frame that isn't the trusted
    // renderer entry point before touching the filesystem / git.
    assertTrustedSender('git', e);
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
    IPC.git.init,
    ipcCommand(DirectoryInputSchema, 'initialized', ({ directoryPath }) => gitInit(directoryPath))
  );
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
  ipcMain.removeHandler(IPC.git.init);
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
