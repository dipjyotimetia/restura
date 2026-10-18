// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ExecutableProbe, resolveStdioCommand } from '../security/mcp-stdio-resolve';

describe('resolveStdioCommand (POSIX, real filesystem)', () => {
  let root: string;
  let bin: string;
  let cwd: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'stdio-resolve-'));
    bin = path.join(root, 'bin');
    cwd = path.join(root, 'project');
    mkdirSync(bin);
    mkdirSync(cwd);
    writeFileSync(path.join(bin, 'srv'), '#!/bin/sh\n');
    chmodSync(path.join(bin, 'srv'), 0o755);
    writeFileSync(path.join(bin, 'noexec'), '');
    chmodSync(path.join(bin, 'noexec'), 0o644);
    // A same-named file in the working directory must never be picked.
    writeFileSync(path.join(cwd, 'srv'), '#!/bin/sh\n');
    chmodSync(path.join(cwd, 'srv'), 0o755);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds a bare name on PATH and returns the absolute path', async () => {
    const res = await resolveStdioCommand('srv', { PATH: `relative/dir::.:${bin}` }, 'darwin');
    expect(res).toEqual({ ok: true, command: { path: path.join(bin, 'srv'), viaCmd: false } });
  });

  it('never searches relative PATH entries (so never the cwd)', async () => {
    const previous = process.cwd();
    process.chdir(root);
    try {
      const res = await resolveStdioCommand('srv', { PATH: '.:project' }, 'linux');
      expect(res.ok).toBe(false);
    } finally {
      process.chdir(previous);
    }
  });

  it('accepts an absolute path and rejects relative paths with separators', async () => {
    expect(await resolveStdioCommand(path.join(bin, 'srv'), { PATH: '' }, 'linux')).toMatchObject({
      ok: true,
    });
    expect(await resolveStdioCommand('./srv', { PATH: bin }, 'linux')).toEqual({
      ok: false,
      error: expect.stringMatching(/relative paths are not allowed/),
    });
    expect(await resolveStdioCommand('bin/srv', { PATH: root }, 'linux')).toMatchObject({
      ok: false,
    });
  });

  it('refuses files that are not executable, directories, and missing names', async () => {
    expect((await resolveStdioCommand('noexec', { PATH: bin }, 'linux')).ok).toBe(false);
    expect((await resolveStdioCommand(bin, { PATH: '' }, 'linux')).ok).toBe(false);
    expect(await resolveStdioCommand('missing', { PATH: bin }, 'linux')).toEqual({
      ok: false,
      error: 'Command not found or not executable: missing',
    });
  });
});

describe('resolveStdioCommand (Windows rules, simulated filesystem)', () => {
  const files = new Set([
    'C:\\Tools\\npx.cmd',
    'C:\\Tools\\node.exe',
    'C:\\Tools\\script.ps1',
    'C:\\Project\\npx.cmd',
  ]);
  const probe: ExecutableProbe = async (file) => files.has(file);
  const env = { Path: 'C:\\Tools;relative;\\\\server\\share', PATHEXT: '.COM;.EXE;.BAT;.CMD;.PS1' };

  it('resolves .exe directly and .cmd through cmd.exe, from PATH only', async () => {
    expect(await resolveStdioCommand('node', env, 'win32', probe)).toEqual({
      ok: true,
      command: { path: 'C:\\Tools\\node.exe', viaCmd: false },
    });
    expect(await resolveStdioCommand('npx', env, 'win32', probe)).toEqual({
      ok: true,
      command: { path: 'C:\\Tools\\npx.cmd', viaCmd: true },
    });
  });

  it('does not launch other PATHEXT types (e.g. .ps1)', async () => {
    expect((await resolveStdioCommand('script', env, 'win32', probe)).ok).toBe(false);
    expect((await resolveStdioCommand('C:\\Tools\\script.ps1', env, 'win32', probe)).ok).toBe(
      false
    );
  });

  it('rejects UNC/device commands and skips UNC PATH entries', async () => {
    expect(await resolveStdioCommand('\\\\server\\share\\x.exe', env, 'win32', probe)).toEqual({
      ok: false,
      error: expect.stringMatching(/UNC/),
    });
    const unc: ExecutableProbe = async (file) => file.startsWith('\\\\server');
    expect((await resolveStdioCommand('evil', env, 'win32', unc)).ok).toBe(false);
  });

  it('resolves an absolute path with or without extension', async () => {
    expect(await resolveStdioCommand('C:\\Tools\\node', env, 'win32', probe)).toMatchObject({
      ok: true,
      command: { path: 'C:\\Tools\\node.exe' },
    });
  });

  it('uses the default PATHEXT when none is set', async () => {
    expect(await resolveStdioCommand('npx', { PATH: 'C:\\Tools' }, 'win32', probe)).toMatchObject({
      ok: true,
      command: { viaCmd: true },
    });
  });
});
