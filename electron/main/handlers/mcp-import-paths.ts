import * as path from 'node:path';

/**
 * The ONLY locations the MCP config importer reads without a user-chosen
 * file (#906). The list is derived from the OS and the user's home, never
 * from renderer input; project-level configs (`.cursor/mcp.json`,
 * `.vscode/mcp.json`) need the file picker.
 */
export interface KnownMcpConfigSource {
  label: string;
  file: string;
}

export function knownMcpConfigSources(
  platform: NodeJS.Platform,
  home: string,
  appData: string | undefined
): KnownMcpConfigSource[] {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  let configRoot: string;
  if (platform === 'darwin') configRoot = join(home, 'Library', 'Application Support');
  else if (platform === 'win32') configRoot = appData || join(home, 'AppData', 'Roaming');
  else configRoot = join(home, '.config');
  return [
    {
      label: 'Claude Desktop',
      file: join(configRoot, 'Claude', 'claude_desktop_config.json'),
    },
    { label: 'Cursor (user)', file: join(home, '.cursor', 'mcp.json') },
    { label: 'VS Code (user mcp.json)', file: join(configRoot, 'Code', 'User', 'mcp.json') },
    {
      label: 'VS Code (user settings.json)',
      file: join(configRoot, 'Code', 'User', 'settings.json'),
    },
  ];
}

/** Collapse the home directory to `~` for display only. */
export function displayPath(file: string, home: string): string {
  const rest = file.slice(home.length);
  return file.startsWith(home) && (rest === '' || rest.startsWith('/') || rest.startsWith('\\'))
    ? `~${rest}`
    : file;
}
