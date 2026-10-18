/**
 * Command resolution for the MCP stdio transport (#854, ADR 0030).
 *
 * Main resolves the command to an absolute path BEFORE asking for consent,
 * so the dialog shows, the consent key covers, and the spawn uses exactly
 * the same file. Bare names are looked up on the child's `PATH` only: the
 * working directory is never searched (Windows would otherwise prefer a
 * same-named file in the cwd), and relative or UNC `PATH` entries are skipped.
 * Relative command paths (`./server`) are refused — use a bare name or an
 * absolute path.
 */

import { promises as fs, constants as fsConstants } from 'node:fs';
import * as nodePath from 'node:path';
import { isUncOrDevicePath } from './mcp-stdio-policy';

export interface ResolvedStdioCommand {
  /** Absolute path that is shown, hashed, and spawned. */
  path: string;
  /** Windows only: the target is a .cmd/.bat run through cmd.exe. */
  viaCmd: boolean;
}

export type ResolveResult =
  | { ok: true; command: ResolvedStdioCommand }
  | { ok: false; error: string };

/** Is `file` an existing regular file we may execute? */
export type ExecutableProbe = (file: string, platform: NodeJS.Platform) => Promise<boolean>;

export const defaultExecutableProbe: ExecutableProbe = async (file, platform) => {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    if (platform !== 'win32') await fs.access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

function envValue(
  env: Record<string, string>,
  name: string,
  platform: NodeJS.Platform
): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

const WINDOWS_DIRECT = new Set(['.exe', '.com']);
const WINDOWS_CMD = new Set(['.cmd', '.bat']);

export async function resolveStdioCommand(
  command: string,
  childEnv: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  probe: ExecutableProbe = defaultExecutableProbe
): Promise<ResolveResult> {
  const p = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const isWin = platform === 'win32';

  if (isWin && isUncOrDevicePath(command)) {
    return { ok: false, error: 'Network (UNC) and device paths are not allowed as the command' };
  }

  // Windows: try the name as given when it already has a launchable
  // extension, otherwise each PATHEXT extension (restricted to the four we
  // know how to run safely).
  const extensions = isWin
    ? (envValue(childEnv, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((e) => e.trim().toLowerCase())
        .filter((e) => WINDOWS_DIRECT.has(e) || WINDOWS_CMD.has(e))
    : [];
  const candidatesFor = (base: string): string[] => {
    if (!isWin) return [base];
    const ext = p.extname(base).toLowerCase();
    return WINDOWS_DIRECT.has(ext) || WINDOWS_CMD.has(ext)
      ? [base]
      : extensions.map((e) => base + e);
  };

  let candidates: string[];
  if (p.isAbsolute(command)) {
    candidates = candidatesFor(p.normalize(command));
  } else if (command.includes('/') || (isWin && command.includes('\\'))) {
    return {
      ok: false,
      error:
        'Use a command name found on PATH or an absolute path (relative paths are not allowed)',
    };
  } else {
    const dirs = (envValue(childEnv, 'PATH', platform) ?? '')
      .split(isWin ? ';' : ':')
      .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
      .filter((d) => d !== '' && p.isAbsolute(d) && !(isWin && isUncOrDevicePath(d)));
    candidates = dirs.flatMap((dir) => candidatesFor(p.join(dir, command)));
  }

  for (const candidate of candidates) {
    if (!(await probe(candidate, platform))) continue;
    if (!isWin) return { ok: true, command: { path: candidate, viaCmd: false } };
    const ext = p.extname(candidate).toLowerCase();
    if (WINDOWS_DIRECT.has(ext)) return { ok: true, command: { path: candidate, viaCmd: false } };
    if (WINDOWS_CMD.has(ext)) return { ok: true, command: { path: candidate, viaCmd: true } };
  }
  return {
    ok: false,
    error: isWin
      ? `Command not found as an .exe, .com, .cmd or .bat file on PATH: ${command}`
      : `Command not found or not executable: ${command}`,
  };
}
