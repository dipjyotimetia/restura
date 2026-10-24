import type { SecretValue } from '@shared/secrets/secret-ref';
import type { McpStdioConfig } from '@/types';
import type { McpClientStdioOptions } from './mcpClient';

export const MCP_STDIO_WEB_ERROR =
  'The stdio transport launches a local process and is only available in the desktop app';

/**
 * Turn the saved stdio config into the launch the desktop app is asked to
 * approve: `{{vars}}` resolved, blank argument lines dropped, disabled env
 * rows skipped. Env rows backed by a `secretRef` pass the ref through
 * untouched — a handle is resolved only in the main process at spawn time.
 */
export function buildStdioLaunch(
  stdio: McpStdioConfig | undefined,
  resolve: (text: string) => string
): McpClientStdioOptions {
  const launch: McpClientStdioOptions = {
    command: resolve(stdio?.command ?? '').trim(),
    args: (stdio?.args ?? []).filter((arg) => arg.trim() !== '').map(resolve),
  };
  const cwd = stdio?.cwd ? resolve(stdio.cwd).trim() : '';
  if (cwd) launch.cwd = cwd;

  const env: Record<string, SecretValue> = {};
  for (const row of stdio?.env ?? []) {
    const name = row.key.trim();
    if (row.enabled === false || !name) continue;
    env[name] = row.secretRef ?? resolve(row.value);
  }
  if (Object.keys(env).length > 0) launch.env = env;
  return launch;
}
