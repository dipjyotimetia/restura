import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliRunResult } from './cliResult';

export interface ShellRunOptions {
  cliCommand: string;
  collectionDir: string;
  /** Restricts the run to a folder path (CLI --folder). */
  folder?: string;
  /** CLI --include patterns (substring/glob on name + relativePath). */
  include?: string[];
  /** Path to an env file (CLI --env). */
  envFile?: string;
  allowLocalhost: boolean;
  signal?: AbortSignal;
}

export class ShellRunError extends Error {}

/** Thrown when the run was aborted via its AbortSignal (user cancellation). */
export class ShellRunCancelled extends Error {}

const execFileAsync = (
  cmd: string,
  args: string[],
  opts: { signal?: AbortSignal }
): Promise<{ code: number; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { signal: opts.signal, maxBuffer: 16 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        const stderrStr = stderr.toString();
        if (err) {
          const code = (err as { code?: unknown }).code;
          // Cancellation: AbortController.abort() surfaces as ABORT_ERR. Mark it
          // distinctly so callers treat it as cancelled, not a spawn failure.
          if (code === 'ABORT_ERR' || opts.signal?.aborted) {
            reject(new ShellRunCancelled());
            return;
          }
          // Other string codes are spawn-level failures (ENOENT etc.).
          if (typeof code === 'string') {
            reject(new ShellRunError(`Failed to run '${cmd}': ${err.message}`));
            return;
          }
          // Numeric code = process exit code. Non-zero is normal: 1 = some tests
          // failed (JSON still written), 2 = internal CLI error (no/invalid JSON).
          resolve({ code: typeof code === 'number' ? code : 1, stderr: stderrStr });
          return;
        }
        resolve({ code: 0, stderr: stderrStr });
      }
    );
  });

/**
 * Run a collection (or a filtered subset) through the `restura` CLI with the
 * JSON reporter and parse the result file. Exit code 1 (failures) still yields
 * valid JSON; only exit 2 (internal error) throws.
 */
export async function runViaShell(options: ShellRunOptions): Promise<CliRunResult> {
  const dir = await mkdtemp(join(tmpdir(), 'restura-vscode-'));
  const outFile = join(dir, 'result.json');
  try {
    const args = [
      'run',
      options.collectionDir,
      '--reporter',
      'json',
      '--reporter-output',
      `json=${outFile}`,
    ];
    if (options.allowLocalhost) args.push('--allow-localhost');
    if (options.folder) args.push('--folder', options.folder);
    for (const inc of options.include ?? []) args.push('--include', inc);
    if (options.envFile) args.push('--env', options.envFile);

    const { code, stderr } = await execFileAsync(options.cliCommand, args, {
      signal: options.signal,
    });

    if (code === 2) {
      throw new ShellRunError(stderr.trim() || 'restura CLI exited with code 2 (internal error)');
    }

    let raw: string;
    try {
      raw = await readFile(outFile, 'utf8');
    } catch {
      throw new ShellRunError(
        `restura CLI produced no result file (exit ${code}). ${stderr.trim()}`.trim()
      );
    }
    return JSON.parse(raw) as CliRunResult;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
