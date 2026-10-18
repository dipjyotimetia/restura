/**
 * Policy for the desktop-only MCP stdio transport (#854, ADR 0030).
 *
 * Spawning a local process from data that can arrive in an imported
 * collection is a new trust boundary. This module owns the pure, testable
 * pieces of that policy: input bounds, the execution-sensitive env names,
 * and the child-environment allowlist. Consent lives in
 * `mcp-stdio-consent.ts`; process lifecycle in `handlers/mcp-stdio-session.ts`.
 */

import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/client/stdio';

/** Bounds enforced by the IPC Zod schema (and mirrored in the consent dialog). */
export const MCP_STDIO_LIMITS = {
  commandMaxLength: 4096,
  argMaxLength: 8192,
  argsMaxCount: 128,
  argsTotalMaxLength: 64 * 1024,
  cwdMaxLength: 4096,
  envMaxEntries: 100,
  envNameMaxLength: 256,
  envValueMaxLength: 32 * 1024,
} as const;

/**
 * Minimal environment a stdio MCP server inherits from the app. Everything
 * else in `process.env` (tokens, cloud credentials, `ELECTRON_RUN_AS_NODE`,
 * `NODE_OPTIONS`, proxy settings, …) is withheld; the user adds what a server
 * needs explicitly.
 *
 * Decision on the SDK's `getDefaultEnvironment()`: `StdioClientTransport`
 * always spawns with `{ ...getDefaultEnvironment(), ...params.env }` — it
 * cannot be turned off. We therefore pass a FULLY computed env and make this
 * allowlist a superset of the SDK's `DEFAULT_INHERITED_ENV_VARS`, so the SDK
 * merge can never add a variable this module did not choose. A unit test pins
 * the superset relation: if a future SDK widens its list, the test fails and
 * the addition gets an explicit review here.
 */
const POSIX_BASE = ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER', 'TMPDIR'];
const WINDOWS_BASE = [
  'APPDATA',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
];
/** Locale vars, so servers print/parse text the way the user's terminal would. */
const LOCALE_VARS = [
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_TIME',
  'LC_COLLATE',
  'LC_MONETARY',
  'TZ',
];

export function minimalEnvAllowlist(platform: NodeJS.Platform = process.platform): string[] {
  const base = platform === 'win32' ? WINDOWS_BASE : POSIX_BASE;
  return [...new Set([...base, ...LOCALE_VARS, ...DEFAULT_INHERITED_ENV_VARS])];
}

/**
 * Build the complete child environment: the minimal allowlist read from the
 * parent env, then the user's variables on top. On Windows env names are
 * case-insensitive, so the lookup is too. Values that look like exported
 * bash functions (`() {`) are skipped — same rule as the SDK (Shellshock).
 */
export function buildStdioChildEnv(
  userEnv: Record<string, string>,
  parentEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const env: Record<string, string> = {};
  const parentKeys = Object.keys(parentEnv);
  for (const name of minimalEnvAllowlist(platform)) {
    const key =
      platform === 'win32'
        ? parentKeys.find((candidate) => candidate.toUpperCase() === name.toUpperCase())
        : parentKeys.includes(name)
          ? name
          : undefined;
    if (key === undefined) continue;
    const value = parentEnv[key];
    if (value === undefined || value.startsWith('()')) continue;
    env[key] = value;
  }
  for (const [name, value] of Object.entries(userEnv)) {
    if (platform === 'win32') {
      // Drop an inherited spelling of the same name so the user's value wins.
      for (const existing of Object.keys(env)) {
        if (existing.toUpperCase() === name.toUpperCase()) delete env[existing];
      }
    }
    env[name] = value;
  }
  return env;
}

/**
 * Env vars that change WHAT runs (loader injection, interpreter startup
 * hooks, package-registry redirection, search paths). Their values must be
 * inline (never a secret handle) so the consent dialog can show them, and
 * they are always displayed in full there. Note every env value is part of
 * the consent key regardless — this list only governs display + handle use.
 */
const EXECUTION_SENSITIVE_EXACT = new Set([
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SHELL',
  'HOME',
  'USERPROFILE',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'CLASSPATH',
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'YARN_RC_FILENAME',
  'YARN_REGISTRY',
  'YARN_NPM_REGISTRY_SERVER',
  'BUN_INSTALL',
  'BUN_CONFIG_REGISTRY',
  'DENO_DIR',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_EXEC_PATH',
  'GIT_CONFIG_GLOBAL',
  'GOFLAGS',
  'GOPATH',
  'GOROOT',
  'GOPROXY',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
]);
/**
 * Prefix families where (almost) every member changes what runs. Kept narrow
 * on purpose: a broad prefix (e.g. `NODE_`, `GO`) would also catch secrets
 * such as `NODE_AUTH_TOKEN` / `GOOGLE_API_KEY` and forbid storing them as
 * secret handles.
 */
const EXECUTION_SENSITIVE_PREFIXES = ['LD_', 'DYLD_', 'NPM_CONFIG_', 'PYTHON', 'PIP_', 'UV_'];

export function isExecutionSensitiveEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (EXECUTION_SENSITIVE_EXACT.has(upper)) return true;
  return EXECUTION_SENSITIVE_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** C0 control characters (except TAB) and DEL — never valid in argv/paths we accept. */
const CONTROL_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f]/;

export function hasControlChars(value: string): boolean {
  return CONTROL_CHARS.test(value);
}
