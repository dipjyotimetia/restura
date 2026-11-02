import { describe, expect, it, vi } from 'vitest';

// A validator that gives up on one schema and throws on another (#911 M1 handling).
vi.mock('./mcp-output-schema', () => ({
  MCP_SCHEMA_TOO_COMPLEX: 'schema too complex — validation skipped',
  validateAgainstSchema: (schema: { x?: string }) => {
    if (schema?.x === 'throw') throw new Error('boom');
    if (schema?.x === 'complex')
      return [{ path: '$', message: 'schema too complex — validation skipped' }];
    return [];
  },
  validateToolOutput: (schema: { x?: string } | undefined) => {
    if (schema?.x === 'throw') throw new Error('boom');
    if (schema?.x === 'complex') {
      return {
        status: 'skipped',
        issues: [{ path: '$', message: 'schema too complex — validation skipped' }],
      };
    }
    if (schema?.x === 'notes') return { status: 'valid', notes: ['pattern check skipped'] };
    return { status: 'valid' };
  },
}));

import { type McpConformanceSession, runMcpConformance } from './mcp-conformance';
import { conformanceReportToJson, conformanceReportToMarkdown } from './mcp-conformance-report';
import { hashJson, mdCode, mdText, sanitizeText, stripControl } from './mcp-conformance-text';

interface Opts {
  tools?: unknown[];
  serverInfo?: unknown;
  capabilities?: unknown;
  call?: (params: unknown) => unknown;
  request?: McpConformanceSession['request'];
  protocolVersion?: string;
}

function session(o: Opts, calls: unknown[] = []): McpConformanceSession {
  return {
    protocolVersion: o.protocolVersion ?? '2025-06-18',
    serverCapabilities: o.capabilities ?? { tools: {} },
    serverInfo: o.serverInfo ?? { name: 'n', version: '1' },
    request:
      o.request ??
      (async (method, params) => {
        if (method === 'tools/list') return { tools: o.tools ?? [] };
        if (method === 'tools/call') {
          calls.push(params);
          return o.call ? o.call(params) : { content: [] };
        }
        throw Object.assign(new Error('nf'), { code: -32601 });
      }),
    close: async () => {},
  };
}

const ro = { annotations: { readOnlyHint: true } };
const tool = (name: string, extra: object = {}) => ({
  name,
  inputSchema: { type: 'object' },
  ...ro,
  ...extra,
});

describe('conformance engine hardening', () => {
  it('never calls duplicate-named tools or contradictory read-only+destructive tools', async () => {
    const calls: unknown[] = [];
    const report = await runMcpConformance(
      {
        open: async () =>
          session(
            {
              tools: [
                tool('dup'),
                tool('dup'),
                tool('both', { annotations: { readOnlyHint: true, destructiveHint: true } }),
                tool('fine'),
              ],
            },
            calls
          ),
      },
      { eras: ['legacy'], sampleCalls: 'read-only' }
    );
    expect(calls).toEqual([{ name: 'fine', arguments: {} }]);
    const reasons = Object.fromEntries(
      report.eras[0]?.samples.map((s) => [s.tool, s.reason]) ?? []
    );
    expect(reasons.both).toMatch(/destructive/);
    expect(report.eras[0]?.samples.filter((s) => s.reason === 'duplicate tool name')).toHaveLength(
      2
    );
  });

  it('skips sampling and validation gracefully when the validator is overwhelmed', async () => {
    const report = await runMcpConformance(
      {
        open: async () =>
          session({
            tools: [
              tool('in-throw', { inputSchema: { x: 'throw' } }),
              tool('in-complex', { inputSchema: { x: 'complex' } }),
              tool('out-throw', { outputSchema: { x: 'throw' } }),
              tool('out-complex', { outputSchema: { x: 'complex' } }),
            ],
          }),
      },
      { eras: ['legacy'], sampleCalls: 'read-only' }
    );
    const complex = report.findings.filter((f) => f.code === 'tools.schema-too-complex');
    expect(complex.map((f) => f.subject).sort()).toEqual([
      'in-complex',
      'in-throw',
      'out-complex',
      'out-throw',
    ]);
    expect(report.summary.errors).toBe(0);
  });

  it('reports validator notes as info, not violations', async () => {
    const report = await runMcpConformance(
      { open: async () => session({ tools: [tool('n', { outputSchema: { x: 'notes' } })] }) },
      { eras: ['legacy'], sampleCalls: 'read-only' }
    );
    const f = report.findings.find((x) => x.code === 'tools.schema-check-note');
    expect(f?.severity).toBe('info');
    expect(report.summary.errors).toBe(0);
  });

  it('scrubs secrets, strips control characters and bounds every server string', async () => {
    const secret = 'Bearer-super-secret-token';
    const nasty = `\u001b[31mred\u001b[0m\n# injected ${secret} ${'x'.repeat(900)}`;
    const report = await runMcpConformance(
      {
        open: async () =>
          session({
            serverInfo: { name: nasty, version: `v${secret}`, title: nasty },
            capabilities: { tools: {}, experimental: { [nasty]: nasty } },
            tools: [tool(nasty)],
            request: async (method, params) => {
              if (method === 'tools/list') return { tools: [tool(nasty)] };
              if (method === 'tools/call')
                throw new Error(`upstream said ${secret}\n${'y'.repeat(2000)}`);
              void params;
              throw new Error(`nope ${secret}`);
            },
          }),
      },
      {
        eras: ['legacy'],
        sampleCalls: 'read-only',
        secrets: [secret, 'short'],
        target: `https://h.example/${secret}`,
      }
    );
    const json = conformanceReportToJson(report);
    expect(json).not.toContain(secret);
    expect(json).not.toContain('\\u001b');
    expect(json).toContain('[redacted]');
    for (const f of report.findings) expect(f.message.length).toBeLessThanOrEqual(501);
    expect(report.eras[0]?.serverInfo?.name?.length).toBeLessThanOrEqual(201);
    expect(report.eras[0]?.listing.tools[0]?.name).not.toContain('\n');
    expect(report.eras[0]?.samples[0]?.reason?.length).toBeLessThanOrEqual(501);
  });

  it('caps list size and finding count with explicit markers', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => tool(`t${i}`));
    const big = await runMcpConformance(
      { open: async () => session({ tools: many }) },
      { eras: ['legacy'] }
    );
    expect(big.eras[0]?.listing.tools).toHaveLength(1000);
    expect(big.findings.map((f) => f.code)).toContain('list.truncated');

    const bad = Array.from({ length: 700 }, () => ({ name: '' }));
    const noisy = await runMcpConformance(
      { open: async () => session({ tools: bad }) },
      { eras: ['legacy'] }
    );
    expect(noisy.eras[0]?.findings.length).toBeLessThanOrEqual(501);
    expect(noisy.findings.map((f) => f.code)).toContain('report.truncated');
  });

  it('keeps only name and hashes for descriptors, never schema bodies', async () => {
    const report = await runMcpConformance(
      {
        open: async () =>
          session({
            tools: [
              tool('t', {
                description: 'SECRET-DESC',
                inputSchema: { type: 'object', description: 'SECRET-IN' },
              }),
            ],
          }),
      },
      { eras: ['legacy'] }
    );
    const json = conformanceReportToJson(report);
    expect(json).not.toContain('SECRET-DESC');
    expect(json).not.toContain('SECRET-IN');
    expect(Object.keys(report.eras[0]?.listing.tools[0]?.fields ?? {})).toEqual(
      expect.arrayContaining(['description', 'inputSchema'])
    );
  });

  it('aborts in-flight and later requests when the run signal fires', async () => {
    const controller = new AbortController();
    const hung = session({
      request: (method) =>
        method === 'tools/list' ? new Promise(() => {}) : Promise.reject(new Error('nf')),
    });
    const run = runMcpConformance(
      { open: async () => hung },
      { eras: ['legacy'], signal: controller.signal }
    );
    setTimeout(() => controller.abort(), 20);
    const report = await run;
    expect(report.findings.some((f) => /aborted/.test(f.message))).toBe(true);

    const pre = new AbortController();
    pre.abort();
    const r2 = await runMcpConformance(
      { open: async () => session({}) },
      { eras: ['legacy'], signal: pre.signal }
    );
    expect(r2.findings.some((f) => /aborted/.test(f.message))).toBe(true);
  });
});

describe('markdown injection hardening', () => {
  const payloads = [
    '\n# x',
    '`code` ``',
    '[x](http://evil.example)',
    '<img src=x onerror=alert(1)>',
    '\u001b]0;title\u0007\u001b[2J',
    '![i](http://evil.example/p.png)',
    '*bold* _it_ & | pipe',
  ];

  it('escapes metacharacters in inline text', () => {
    for (const p of payloads) {
      const out = mdText(p);
      expect(out).not.toMatch(/\n|\u001b/);
      expect(out).not.toMatch(/(^|[^\\])[`<>[\]()!*_|#&]/);
    }
    expect(mdText('[x](http://evil.example)')).toBe('\\[x\\]\\(http://evil.example\\)');
    expect(mdCode('a`b')).toBe("a'b");
    expect(stripControl('a b\r\nc\u009fd\u001b[31me')).toBe('a b cde');
    expect(mdText('y'.repeat(500)).length).toBeLessThanOrEqual(201);
  });

  it('never lets server-derived strings create structure in the rendered report', async () => {
    const report = await runMcpConformance(
      {
        open: async (era) =>
          session({
            protocolVersion: era === 'legacy' ? '2025-06-18' : '2026-07-28',
            serverInfo: { name: '[x](http://evil.example)', version: '<img src=x>' },
            capabilities: { tools: {}, 'x`y': {} },
            tools: [tool('\n# pwn'), tool('`tick`')],
          }),
      },
      { target: 'https://h.example/`x`' }
    );
    // Make the modern side differ so the raw "Server info: differs (...)" line renders.
    if (report.diff) report.diff.serverInfo.differs = true;
    const md = conformanceReportToMarkdown(report);
    expect(md).not.toMatch(/^# pwn/m);
    expect(md).not.toMatch(/(^|[^\\\\])<img/);
    expect(md).not.toMatch(/[^\\\\]\]\(http/);
    expect(md).not.toMatch(/\u001b/);
    expect(md.split('\n').filter((l) => l.startsWith('# '))).toEqual(['# MCP conformance report']);
  });

  it('hashes deterministically regardless of key order', () => {
    expect(hashJson({ a: 1, b: [1, 2] })).toBe(hashJson({ b: [1, 2], a: 1 }));
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
    expect(sanitizeText('abcdefgh-secret', ['abcdefgh-secret'])).toBe('[redacted]');
  });

  it('does not let an embedded control character smuggle a secret past the scrubber', () => {
    const secret = 'Bearer-super-secret-token';
    const split = `${secret.slice(0, 4)}\u0000${secret.slice(4)}`;
    expect(sanitizeText(`echo ${split}`, [secret])).not.toContain(secret);
    expect(sanitizeText(`echo ${split}`, [secret])).toContain('[redacted]');
  });
});
