import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

/**
 * Resolve the `restura` CLI binary used by the Test Explorer. Order:
 *   1. `restura.cliPath` setting (explicit override)
 *   2. `<workspaceFolder>/node_modules/.bin/restura[.cmd]`
 *   3. bare `restura` (resolved against PATH by the OS)
 *
 * Returns the command string to spawn. The caller spawns without a shell, so
 * the `.cmd` shim on Windows is selected here.
 */
export function resolveCliCommand(workspaceFolder: vscode.WorkspaceFolder | undefined): string {
  const configured = vscode.workspace.getConfiguration('restura').get<string>('cliPath');
  if (configured && configured.trim()) return configured.trim();

  if (workspaceFolder) {
    const binName = process.platform === 'win32' ? 'restura.cmd' : 'restura';
    const local = join(workspaceFolder.uri.fsPath, 'node_modules', '.bin', binName);
    if (existsSync(local)) return local;
  }

  return 'restura';
}
