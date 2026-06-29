import * as vscode from 'vscode';

/** Resolved `restura.*` settings. Defaults live here only — keep them in sync
 *  with the `configuration` contribution in package.json. */
export interface ResturaSettings {
  /** Explicit path to the `restura` CLI ('' = auto-resolve). */
  cliPath: string;
  allowLocalhost: boolean;
  allowPrivateIPs: boolean;
  /** Path to an env file passed to the CLI (--env); '' = none. */
  envFile: string;
}

export function getResturaSettings(): ResturaSettings {
  const c = vscode.workspace.getConfiguration('restura');
  return {
    cliPath: (c.get<string>('cliPath') ?? '').trim(),
    allowLocalhost: c.get<boolean>('allowLocalhost', true),
    allowPrivateIPs: c.get<boolean>('allowPrivateIPs', false),
    envFile: (c.get<string>('env') ?? '').trim(),
  };
}
