import type { McpConformanceDeps, McpConformanceReport } from '@shared/protocol/mcp-conformance';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type MockMcpV2ServerHandle,
  startMockMcpV2Server,
} from '../../../../e2e/mocks/mcpV2Server';
import {
  conformanceExitCode,
  createSdkConformanceDeps,
  executeMcpConformanceCommand,
  type McpConformanceCommandDependencies,
  type McpConformanceCommandOpts,
} from '../mcp';

const baseOpts: McpConformanceCommandOpts = {
  transport: 'streamable-http',
  eras: 'legacy,modern',
  sampleCalls: 'off',
  format: 'markdown',
  timeout: '5000',
  allowLocalhost: false,
  failOn: 'error',
};

function fakeDeps(
  open: McpConformanceDeps['open'],
  env: Record<string, string> = {}
): McpConformanceCommandDependencies & { out: string[]; err: string[]; files: string[][] } {
  const out: string[] = [];
  const err: string[] = [];
  const files: string[][] = [];
  return {
    environment: env,
    createDeps: vi.fn(() => ({ open })),
    writeFile: async (p, d) => {
      files.push([p, d]);
    },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    out,
    err,
    files,
  };
}

const okSession = (extra: Partial<Record<string, unknown>> = {}) =>
  ({
    protocolVersion: '2025-06-18',
    serverCapabilities: {},
    serverInfo: { name: 's', version: '1' },
    request: async () => {
      throw Object.assign(new Error('nf'), { code: -32601 });
    },
    close: async () => {},
    ...extra,
  }) as Awaited<ReturnType<McpConformanceDeps['open']>>;

describe('restura mcp conformance', () => {
  it('prints Markdown to stdout, summary to stderr, exit 0 on a clean server', async () => {
    const deps = fakeDeps(async () => okSession());
    await expect(
      executeMcpConformanceCommand('https://h.example/mcp', baseOpts, deps)
    ).resolves.toBe(0);
    expect(deps.out.join('')).toContain('# MCP conformance report');
    expect(deps.err.join('')).toContain('0 error(s)');
  });

  it('writes JSON to --output and exits 1 when the legacy era fails', async () => {
    const deps = fakeDeps(async () => {
      throw new Error('refused');
    });
    const code = await executeMcpConformanceCommand(
      'https://h.example/mcp',
      { ...baseOpts, format: 'json', output: 'r.json' },
      deps
    );
    expect(code).toBe(1);
    expect(deps.out).toEqual([]);
    const [path, data] = deps.files[0] ?? [];
    expect(path).toBe('r.json');
    // A refused connection says nothing about era support: both eras fail.
    expect(JSON.parse(data ?? '{}').summary.errors).toBe(2);
  });

  it('honours --fail-on', () => {
    const report = { summary: { errors: 0, warnings: 2, info: 0 } } as McpConformanceReport;
    expect(conformanceExitCode(report, 'error')).toBe(0);
    expect(conformanceExitCode(report, 'warning')).toBe(1);
    expect(conformanceExitCode(report, 'never')).toBe(0);
    expect(
      conformanceExitCode(
        { summary: { errors: 1, warnings: 0, info: 0 } } as McpConformanceReport,
        'never'
      )
    ).toBe(0);
  });

  it('resolves --header and --header-env into the connection headers', async () => {
    const deps = fakeDeps(async () => okSession(), { TOK: 'sekret' });
    await executeMcpConformanceCommand(
      'https://h.example/mcp',
      { ...baseOpts, header: ['X-A: b: c'], headerEnv: ['Authorization=TOK'] },
      deps
    );
    const cfg = vi.mocked(deps.createDeps).mock.calls[0]?.[0];
    expect(cfg?.headers).toMatchObject({ 'X-A': 'b: c', Authorization: 'sekret' });
    // Secrets never reach the rendered report.
    expect(deps.out.join('')).not.toContain('sekret');
  });

  it.each([
    [{ transport: 'ws' }, /--transport/],
    [{ eras: 'legacy,future' }, /--eras/],
    [{ sampleCalls: 'all' }, /--sample-calls/],
    [{ format: 'xml' }, /--format/],
    [{ failOn: 'x' }, /--fail-on/],
    [{ timeout: '0' }, /--timeout/],
    [{ header: ['nocolon'] }, /--header expects/],
    [{ headerEnv: ['bad'] }, /--header-env expects/],
    [{ headerEnv: ['A=MISSING'] }, /MISSING/],
    [{ approveTool: ['x'] }, /--approve-tool requires/],
  ])('rejects invalid options %j', async (patch, message) => {
    const deps = fakeDeps(async () => okSession());
    await expect(
      executeMcpConformanceCommand('https://h.example/mcp', { ...baseOpts, ...patch }, deps)
    ).rejects.toThrow(message);
  });

  it('refuses localhost targets without --allow-localhost (SSRF preflight)', async () => {
    const deps = fakeDeps(async () => okSession());
    await expect(
      executeMcpConformanceCommand('http://127.0.0.1:1/mcp', baseOpts, deps)
    ).rejects.toThrow();
    expect(deps.createDeps).not.toHaveBeenCalled();
  });
});

describe('restura mcp conformance against the dual-era mock', () => {
  let mock: MockMcpV2ServerHandle | undefined;
  afterEach(async () => {
    await mock?.close();
    mock = undefined;
  });

  it('checks both eras end to end with the real SDK + pinned fetch', async () => {
    mock = await startMockMcpV2Server();
    const out: string[] = [];
    const code = await executeMcpConformanceCommand(
      mock.url,
      { ...baseOpts, format: 'json', allowLocalhost: true },
      {
        environment: {},
        // Real SDK deps: import lazily so the unit tests above never open sockets.
        createDeps: createSdkConformanceDeps,
        writeFile: async () => {},
        stdout: (t) => out.push(t),
        stderr: () => {},
      }
    );
    const report = JSON.parse(out.join('')) as McpConformanceReport;
    expect(code).toBe(0);
    expect(report.eras.map((e) => [e.era, e.status])).toEqual([
      ['legacy', 'ok'],
      ['modern', 'ok'],
    ]);
    expect(report.diff).not.toBeNull();
  });
});

describe('restura mcp conformance hardening', () => {
  it('rejects URLs with embedded credentials', async () => {
    const deps = fakeDeps(async () => okSession());
    await expect(
      executeMcpConformanceCommand('https://user:pw@h.example/mcp', baseOpts, deps)
    ).rejects.toThrow(/credentials/);
    await expect(executeMcpConformanceCommand('not a url', baseOpts, deps)).rejects.toThrow(
      /Invalid MCP server URL/
    );
    expect(deps.createDeps).not.toHaveBeenCalled();
  });

  it('fails clearly when a proxy environment variable is set', async () => {
    const deps = fakeDeps(async () => okSession(), { HTTPS_PROXY: 'http://proxy:3128' });
    await expect(
      executeMcpConformanceCommand('https://h.example/mcp', baseOpts, deps)
    ).rejects.toThrow(/HTTPS_PROXY/);
    expect(deps.createDeps).not.toHaveBeenCalled();
  });

  it('strips ANSI/control sequences and scrubs header secrets from stdout', async () => {
    const secret = 'sk-live-very-secret';
    const deps = fakeDeps(
      async () =>
        okSession({
          serverInfo: {
            name: `\u001b]0;pwned\u0007\u001b[31mevil\u001b[0m ${secret}`,
            version: '1',
          },
        }),
      { TOK: secret }
    );
    await executeMcpConformanceCommand(
      'https://h.example/mcp',
      { ...baseOpts, headerEnv: ['Authorization=TOK'] },
      deps
    );
    const out = deps.out.join('');
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('\u0007');
    expect(out).not.toContain(secret);
    expect(out).toContain('evil');
  });

  it('times out a server that accepts the connection and never answers', async () => {
    const { createServer } = await import('node:net');
    const sockets: import('node:net').Socket[] = [];
    const server = createServer((s) => sockets.push(s)).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as import('node:net').AddressInfo).port;
    try {
      const out: string[] = [];
      const started = Date.now();
      const code = await executeMcpConformanceCommand(
        `http://127.0.0.1:${port}/mcp`,
        { ...baseOpts, eras: 'legacy', format: 'json', timeout: '300', allowLocalhost: true },
        {
          environment: {},
          createDeps: createSdkConformanceDeps,
          writeFile: async () => {},
          stdout: (t) => out.push(t),
          stderr: () => {},
        }
      );
      expect(Date.now() - started).toBeLessThan(5000);
      expect(code).toBe(1);
      expect(JSON.parse(out.join('')).eras[0].status).toBe('failed');
    } finally {
      for (const s of sockets) s.destroy();
      server.close();
    }
  });
});
