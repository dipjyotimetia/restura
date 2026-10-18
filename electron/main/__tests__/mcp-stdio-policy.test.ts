// @vitest-environment node
import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';
import {
  buildStdioChildEnv,
  hasControlChars,
  isExecutionSensitiveEnvName,
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

  it('matches Windows env names case-insensitively, keeps the safe set, and lets user vars win', () => {
    const env = buildStdioChildEnv(
      { Path: 'C:\\custom' },
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
      Path: 'C:\\custom',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\u',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
    });
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
    'BASH_ENV',
  ])('%s is sensitive', (name) => expect(isExecutionSensitiveEnvName(name)).toBe(true));
  it.each(['GITHUB_TOKEN', 'NODE_AUTH_TOKEN', 'GOOGLE_API_KEY', 'API_KEY', 'LOG_LEVEL'])(
    '%s is not (may be a secret handle)',
    (name) => expect(isExecutionSensitiveEnvName(name)).toBe(false)
  );
});

describe('hasControlChars', () => {
  it('flags C0 controls except TAB, and DEL', () => {
    expect(hasControlChars('a\tb')).toBe(false);
    expect(hasControlChars('a\nb')).toBe(true);
    expect(hasControlChars('a\0b')).toBe(true);
    expect(hasControlChars('a\u007fb')).toBe(true);
    expect(hasControlChars('plain -- --flag=1 "q"')).toBe(false);
  });
});
