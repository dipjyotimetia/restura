/**
 * Policy for the desktop-only MCP stdio transport (#854, ADR 0030).
 *
 * Spawning a local process from data that can arrive in an imported
 * collection is a new trust boundary. This module owns the pure, testable
 * pieces of that policy: input bounds, the execution-sensitive env names,
 * the dialog-spoofing character set, and the child-environment allowlist.
 * Consent lives in `mcp-stdio-consent.ts`; command resolution in
 * `mcp-stdio-resolve.ts`; process lifecycle in `handlers/mcp-stdio-session.ts`.
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
 * parent env, then the user's variables on top. Values that look like
 * exported bash functions (`() {`) are skipped — same rule as the SDK
 * (Shellshock).
 *
 * Windows env names are case-insensitive but a JS object is not: if the child
 * env held both `Path` and `PATH`, which one the process sees would depend on
 * ordering (and the SDK merges its own `PATH` underneath). Every name that
 * matches an allowlisted variable case-insensitively is therefore emitted
 * under the allowlist's canonical spelling, so the user's value
 * deterministically replaces the inherited one.
 */
export function buildStdioChildEnv(
  userEnv: Record<string, string>,
  parentEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const allowlist = minimalEnvAllowlist(platform);
  const canonical = (name: string): string => {
    if (platform !== 'win32') return name;
    const upper = name.toUpperCase();
    return allowlist.find((allowed) => allowed.toUpperCase() === upper) ?? name;
  };
  const env: Record<string, string> = {};
  const parentKeys = Object.keys(parentEnv);
  for (const name of allowlist) {
    const key =
      platform === 'win32'
        ? parentKeys.find((candidate) => candidate.toUpperCase() === name.toUpperCase())
        : parentKeys.includes(name)
          ? name
          : undefined;
    if (key === undefined) continue;
    const value = parentEnv[key];
    if (value === undefined || value.startsWith('()')) continue;
    env[name] = value;
  }
  for (const [rawName, value] of Object.entries(userEnv)) {
    const name = canonical(rawName);
    if (platform === 'win32') {
      for (const existing of Object.keys(env)) {
        if (existing.toUpperCase() === name.toUpperCase()) delete env[existing];
      }
    }
    env[name] = value;
  }
  return env;
}

/**
 * Env vars that change WHAT runs or WHERE it connects (loader injection,
 * interpreter/runtime startup hooks, package-registry and config redirection,
 * search paths, proxies, trust stores, helper programs). Their values must be
 * plain (never a secret handle) so the consent dialog can show them, and they
 * are always displayed in full there. Every env value is part of the consent
 * key regardless — this list governs display and handle use.
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
  'JAVA_HOME',
  'MAVEN_OPTS',
  'GRADLE_OPTS',
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
  'GOFLAGS',
  'GOPATH',
  'GOROOT',
  'GOPROXY',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'DOTNET_STARTUP_HOOKS',
  'GCONV_PATH',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'PAGER',
  'EDITOR',
  'VISUAL',
  'SSH_ASKPASS',
  'VIRTUAL_ENV',
  'PHPRC',
]);
/**
 * Prefix families where (almost) every member changes what runs. A broad
 * prefix also forces secrets in that family (e.g. a `GIT_` token) to be plain
 * values; that is the deliberate trade-off for these families.
 */
const EXECUTION_SENSITIVE_PREFIXES = [
  'LD_',
  'DYLD_',
  'NPM_CONFIG_',
  'PYTHON',
  'PIP_',
  'UV_',
  'GIT_',
  'COR_PROFILER',
  'CORECLR_PROFILER',
  'COREPACK_',
  'PNPM_',
  'BUNDLE_',
  'GEM_',
  'CONDA_',
  'DOCKER_',
  'LUA_INIT',
];

export function isExecutionSensitiveEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (EXECUTION_SENSITIVE_EXACT.has(upper)) return true;
  return EXECUTION_SENSITIVE_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * Characters that can make the consent dialog misrepresent what runs: every
 * Unicode control (Cc: C0, DEL, C1 including U+0085), format character (Cf:
 * bidi overrides and isolates, zero-width characters, BOM, soft hyphen) and
 * the line/paragraph separators (Zl/Zp: U+2028/U+2029). Rejected in the
 * command, arguments, working directory and every displayed value or label.
 */
const SPOOFING_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export function hasControlChars(value: string): boolean {
  return SPOOFING_CHARS.test(value);
}

/**
 * Windows UNC and device-namespace paths (two leading slashes or backslashes,
 * which covers `\\server\share`, `//server`, `\\?\` and `\\.\`). As a working
 * directory or command these reach network shares or raw devices.
 */
export function isUncOrDevicePath(value: string): boolean {
  return /^[\\/]{2}/.test(value);
}

/** Characters cmd.exe can still interpret inside cross-spawn's quoting. */
const CMD_UNSAFE_ARG_CHARS = /["%!]/;

/**
 * On Windows a `.cmd`/`.bat` target runs through `cmd.exe /d /s /c`.
 * cross-spawn quotes and caret-escapes each argument, but a batch file
 * re-parses its own arguments (`%*`, `%1`), where quotes and `%`/`!`
 * expansion are not reliably neutralised. Such arguments are refused for
 * these targets.
 */
export function cmdShimArgError(args: readonly string[]): string | undefined {
  const bad = args.findIndex((arg) => CMD_UNSAFE_ARG_CHARS.test(arg));
  return bad === -1
    ? undefined
    : `Argument ${bad} contains a double quote, % or !, which cannot be passed safely to a .cmd/.bat launcher`;
}
