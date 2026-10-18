// @vitest-environment node
import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';
import {
  buildStdioChildEnv,
  cmdShimArgError,
  escapeSpoofingChars,
  hasControlChars,
  hasControlCharsInValue,
  isAutomountPath,
  isExecutionSensitiveEnvName,
  isUncOrDevicePath,
  minimalEnvAllowlist,
} from '../security/mcp-stdio-policy';

describe('stdio child environment allowlist', () => {
  it("is a superset of the SDK's getDefaultEnvironment() list (the SDK merge adds nothing we did not choose)", () => {
    const ours = new Set(minimalEnvAllowlist(process.platform));
    for (const name of DEFAULT_INHERITED_ENV_VARS) expect(ours.has(name)).toBe(true);
  });

  it('passes only allowlisted parent vars plus user vars (POSIX)', () => {
    const env = buildStdioChildEnv(
      { MY_TOKEN: 'abc' },
      {
        PATH: '/usr/bin',
        HOME: '/home/u',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'C',
        AWS_SECRET_ACCESS_KEY: 'nope',
        GITHUB_TOKEN: 'nope',
        NODE_OPTIONS: '--require /tmp/evil.js',
        ELECTRON_RUN_AS_NODE: '1',
        HTTPS_PROXY: 'http://proxy',
      },
      'darwin'
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      MY_TOKEN: 'abc',
    });
  });

  it('lets the user override an inherited var', () => {
    expect(buildStdioChildEnv({ PATH: '/opt/bin' }, { PATH: '/usr/bin' }, 'linux').PATH).toBe(
      '/opt/bin'
    );
  });

  it('skips exported bash functions (Shellshock-shaped values)', () => {
    expect(buildStdioChildEnv({}, { SHELL: '() { :; }; echo pwned', HOME: '/h' }, 'linux')).toEqual(
      { HOME: '/h' }
    );
  });

  it('canonicalises Windows env names so the user value deterministically wins', () => {
    const env = buildStdioChildEnv(
      { Path: 'C:\\custom', systemroot: 'C:\\Win2', MyVar: 'x' },
      {
        Path: 'C:\\Windows',
        SystemRoot: 'C:\\Windows',
        USERPROFILE: 'C:\\Users\\u',
        APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
        SECRET_THING: 'nope',
      },
      'win32'
    );
    expect(env).toEqual({
      PATH: 'C:\\custom',
      SYSTEMROOT: 'C:\\Win2',
      USERPROFILE: 'C:\\Users\\u',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
      MyVar: 'x',
    });
    // No case-variant duplicates survive for the SDK merge to shadow.
    const upper = Object.keys(env).map((k) => k.toUpperCase());
    expect(new Set(upper).size).toBe(upper.length);
  });

  it('never includes app-only vars in the allowlist', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const list = minimalEnvAllowlist(platform);
      for (const forbidden of [
        'NODE_OPTIONS',
        'ELECTRON_RUN_AS_NODE',
        'HTTPS_PROXY',
        'AWS_PROFILE',
      ]) {
        expect(list).not.toContain(forbidden);
      }
    }
  });
});

describe('isExecutionSensitiveEnvName', () => {
  it.each([
    'PATH',
    'path',
    'NODE_OPTIONS',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'NPM_CONFIG_REGISTRY',
    'npm_config_registry',
    'PYTHONPATH',
    'PIP_INDEX_URL',
    'UV_INDEX_URL',
    'GIT_SSH_COMMAND',
    'GIT_TOKEN',
    'BASH_ENV',
    'DOTNET_STARTUP_HOOKS',
    'COR_PROFILER_PATH',
    'CORECLR_PROFILER',
    'GCONV_PATH',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'HTTP_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'SSL_CERT_FILE',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
    'PAGER',
    'GIT_PAGER',
    'EDITOR',
    'VISUAL',
    'GIT_ASKPASS',
    'SSH_ASKPASS',
    'MAVEN_OPTS',
    'GRADLE_OPTS',
    'JAVA_HOME',
    'COREPACK_HOME',
    'PNPM_HOME',
    'BUNDLE_GEMFILE',
    'GEM_HOME',
    'CONDA_PREFIX',
    'VIRTUAL_ENV',
    'PHPRC',
    'LUA_INIT',
    'LUA_INIT_5_4',
    'DOCKER_HOST',
    'DOCKER_CERT_PATH',
    'KUBECONFIG',
    'AWS_CONFIG_FILE',
    'CLOUDSDK_CONFIG',
    'TF_CLI_CONFIG_FILE',
    'PERLLIB',
    'PERL5DB',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ])('%s is sensitive', (name) => expect(isExecutionSensitiveEnvName(name)).toBe(true));
  it.each(['GITHUB_TOKEN', 'NODE_AUTH_TOKEN', 'GOOGLE_API_KEY', 'API_KEY', 'LOG_LEVEL'])(
    '%s is not (may be a secret handle)',
    (name) => expect(isExecutionSensitiveEnvName(name)).toBe(false)
  );
});

describe('hasControlChars (dialog-spoofing characters)', () => {
  it.each([
    ['TAB', 'a\tb'],
    ['LF', 'a\nb'],
    ['NUL', 'a\0b'],
    ['DEL', 'a\u007fb'],
    ['NEL', 'a\u0085b'],
    ['RLO', 'a\u202Eb'],
    ['LRI', 'a\u2066b'],
    ['ZWSP', 'a\u200Bb'],
    ['ZWJ', 'a\u200Db'],
    ['BOM', '\uFEFFa'],
    ['LS', 'a\u2028b'],
    ['PS', 'a\u2029b'],
  ])('flags %s', (_label, value) => expect(hasControlChars(value)).toBe(true));

  it('accepts ordinary text, including non-ASCII letters', () => {
    expect(hasControlChars('plain -- --flag=1 "q"')).toBe(false);
    expect(hasControlChars('/Users/zoë/プロジェクト')).toBe(false);
  });
});

describe('escapeSpoofingChars / hasControlCharsInValue', () => {
  it('replaces every control/format/separator character with a visible escape', () => {
    expect(escapeSpoofingChars('a\u202Eb\u2028c\u200Bd\nX')).toBe(
      'a\\u{202E}b\\u{2028}c\\u{200B}d\\u{000A}X'
    );
    expect(escapeSpoofingChars('plain /usr/bin')).toBe('plain /usr/bin');
  });

  it('allows TAB/LF/CR in values but nothing else', () => {
    expect(hasControlCharsInValue('a\tb\nc\r')).toBe(false);
    expect(hasControlCharsInValue('a\u202Eb')).toBe(true);
    expect(hasControlCharsInValue('a\0b')).toBe(true);
  });
});

describe('isAutomountPath', () => {
  it('flags macOS automount roots only on darwin', () => {
    expect(isAutomountPath('/net/host/share/bin', 'darwin')).toBe(true);
    expect(isAutomountPath('/Network/Servers/x', 'darwin')).toBe(true);
    expect(isAutomountPath('/net', 'darwin')).toBe(true);
    expect(isAutomountPath('/netstuff/bin', 'darwin')).toBe(false);
    expect(isAutomountPath('/net/host', 'linux')).toBe(false);
  });
});

describe('isUncOrDevicePath', () => {
  it.each(['\\\\server\\share', '//server/share', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', '\\/mixed'])(
    '%s is UNC/device',
    (p) => expect(isUncOrDevicePath(p)).toBe(true)
  );
  it.each(['C:\\dir', '/usr/bin', '\\single'])('%s is not', (p) =>
    expect(isUncOrDevicePath(p)).toBe(false)
  );
});

describe('cmdShimArgError', () => {
  it('refuses quotes, percent and bang in .cmd/.bat arguments', () => {
    expect(cmdShimArgError(['-y', '@scope/server', 'C:\\data dir'])).toBeUndefined();
    expect(cmdShimArgError(['ok', 'a"b'])).toMatch(/Argument 1/);
    expect(cmdShimArgError(['%PATH%'])).toMatch(/Argument 0/);
    expect(cmdShimArgError(['wow!'])).toMatch(/Argument 0/);
  });
});
