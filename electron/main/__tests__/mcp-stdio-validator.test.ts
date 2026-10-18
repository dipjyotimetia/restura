// @vitest-environment node
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStdioConnectPayload, McpStdioConnectSchema } from '../ipc/validators/mcp-stdio';
import { MCP_STDIO_LIMITS } from '../security/mcp-stdio-policy';

const ABS = path.resolve('/tmp');
const base = { connectionId: 'c-1', transport: 'stdio', command: 'npx' } as const;
const parse = (extra: Record<string, unknown>) =>
  McpStdioConnectSchema.safeParse({ ...base, ...extra });

describe('McpStdioConnectSchema', () => {
  it('accepts a typical launch and defaults args to []', () => {
    const ok = McpStdioConnectSchema.parse({ ...base });
    expect(ok.args).toEqual([]);
    const full = parse({
      args: ['-y', '@modelcontextprotocol/server-everything', 'a b "c"'],
      cwd: ABS,
      env: {
        API_KEY: 'k',
        WRAPPED: { kind: 'inline', value: 'v' },
        TOKEN: { kind: 'handle', id: '3b5e8d4f-1c2a-4f7e-9d0b-1a2b3c4d5e6f', label: 'gh' },
      },
    });
    expect(full.success).toBe(true);
  });

  it.each([
    ['bidi override in an argument', { args: ['safe‮exe.txt'] }],
    ['bidi isolate in the command', { command: 'np⁦x' }],
    ['zero-width space in an argument', { args: ['--root​'] }],
    ['BOM in cwd', { cwd: `${ABS}/﻿dir` }],
    ['line separator in an argument', { args: ['a b'] }],
    ['paragraph separator in the command', { command: 'npx ' }],
    ['NEL (C1) in an argument', { args: ['a\u0085b'] }],
    ['TAB in an argument', { args: ['a\tb'] }],
    ['bidi override in an env value', { env: { MODE: 'x‮y' } }],
    ['control char in a handle label', { env: { T: { kind: 'handle', id: 'h', label: 'a‮' } } }],
    ['NUL in command', { command: 'np\0x' }],
    ['newline in command', { command: 'npx\nrm' }],
    ['leading whitespace', { command: ' npx' }],
    ['empty command', { command: '' }],
    ['overlong command', { command: 'a'.repeat(MCP_STDIO_LIMITS.commandMaxLength + 1) }],
    ['NUL in an argument', { args: ['ok', 'b\0ad'] }],
    ['CR/LF in an argument', { args: ['a\r\nb'] }],
    [
      'too many args',
      { args: Array.from({ length: MCP_STDIO_LIMITS.argsMaxCount + 1 }, () => 'x') },
    ],
    ['overlong arg', { args: ['a'.repeat(MCP_STDIO_LIMITS.argMaxLength + 1)] }],
    [
      'args over the total budget',
      { args: Array.from({ length: 10 }, () => 'a'.repeat(MCP_STDIO_LIMITS.argMaxLength)) },
    ],
    ['relative cwd', { cwd: 'some/dir' }],
    ['cwd with NUL', { cwd: `${ABS}\0` }],
    ['bad env name', { env: { 'BAD-NAME': 'x' } }],
    ['env name with =', { env: { 'A=B': 'x' } }],
    ['NUL in env value', { env: { A: 'x\0y' } }],
    [
      'external vault ref',
      {
        env: {
          A: {
            kind: 'external',
            provider: 'aws-secrets-manager',
            profileId: 'p',
            secretId: 's',
          },
        },
      },
    ],
    [
      'handle for an execution-sensitive var',
      { env: { NODE_OPTIONS: { kind: 'handle', id: 'h' } } },
    ],
    ['handle for PATH', { env: { PATH: { kind: 'handle', id: 'h' } } }],
    [
      'too many env vars',
      {
        env: Object.fromEntries(
          Array.from({ length: MCP_STDIO_LIMITS.envMaxEntries + 1 }, (_, i) => [`V${i}`, 'x'])
        ),
      },
    ],
    ['wrong transport', { transport: 'streamable-http' }],
    ['shell flag', { shell: true }],
  ])('rejects %s', (_label, extra) => {
    expect(parse(extra).success).toBe(false);
  });

  it('cannot carry a renderer/import-supplied approval (strict schema)', () => {
    for (const smuggled of [
      { approved: true },
      { consent: 'always' },
      { preApproved: true },
      { consentKey: 'a'.repeat(64) },
    ]) {
      expect(parse(smuggled).success).toBe(false);
    }
    // Nested objects are strict too.
    expect(parse({ env: { A: { kind: 'inline', value: 'v', approved: true } } }).success).toBe(
      false
    );
  });

  it('allows plain values for execution-sensitive vars (shown in the consent dialog)', () => {
    expect(
      parse({ env: { PATH: '/opt/bin:/usr/bin', NODE_OPTIONS: '--max-old-space-size=512' } })
        .success
    ).toBe(true);
  });
});

describe('McpStdioConnectSchema on Windows', () => {
  const realPlatform = process.platform;
  const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p });

  it.each([
    ['UNC cwd', { cwd: '\\\\server\\share\\dir' }],
    ['forward-slash UNC cwd', { cwd: '//server/share' }],
    ['device-namespace cwd', { cwd: '\\\\?\\C:\\dir' }],
    ['device cwd', { cwd: '\\\\.\\PhysicalDrive0' }],
    ['UNC command', { command: '\\\\server\\share\\srv.exe' }],
  ])('rejects %s', (_label, extra) => {
    setPlatform('win32');
    try {
      expect(parse(extra).success).toBe(false);
    } finally {
      setPlatform(realPlatform);
    }
  });
});

describe('isStdioConnectPayload', () => {
  it('detects only an explicit stdio transport', () => {
    expect(isStdioConnectPayload({ transport: 'stdio' })).toBe(true);
    expect(isStdioConnectPayload({ transport: 'streamable-http' })).toBe(false);
    expect(isStdioConnectPayload(null)).toBe(false);
    expect(isStdioConnectPayload('stdio')).toBe(false);
  });
});
