import { describe, expect, it } from 'vitest';
import {
  type McpConformanceSession,
  type McpEra,
  redactConformanceTarget,
  runMcpConformance,
  synthesizeSample,
} from './mcp-conformance';
import { conformanceReportToJson, conformanceReportToMarkdown } from './mcp-conformance-report';

class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number
  ) {
    super(message);
  }
}

interface FakeServer {
  protocolVersion?: string;
  serverInfo?: unknown;
  capabilities?: unknown;
  tools?: unknown[];
  toolsPages?: unknown[][];
  resources?: unknown[];
  prompts?: unknown[];
  callResults?: Record<string, unknown>;
  unknownMethod?: 'error' | 'success';
}

function fakeSession(s: FakeServer, calls: string[]): McpConformanceSession {
  return {
    protocolVersion: s.protocolVersion ?? '2025-06-18',
    serverCapabilities:
      'capabilities' in s ? s.capabilities : { tools: {}, resources: {}, prompts: {} },
    serverInfo: s.serverInfo ?? { name: 'fake', version: '1.0.0' },
    async request(method, params) {
      calls.push(method);
      switch (method) {
        case 'tools/list': {
          if (s.toolsPages) {
            const cursor = (params as { cursor?: string } | undefined)?.cursor;
            const idx = cursor ? Number(cursor) : 0;
            const next = idx + 1 < s.toolsPages.length ? { nextCursor: String(idx + 1) } : {};
            return { tools: s.toolsPages[idx], ...next };
          }
          return { tools: s.tools ?? [] };
        }
        case 'resources/list':
          return { resources: s.resources ?? [] };
        case 'prompts/list':
          return { prompts: s.prompts ?? [] };
        case 'tools/call': {
          const name = (params as { name: string }).name;
          const r = s.callResults?.[name];
          if (r instanceof Error) throw r;
          return r ?? { content: [{ type: 'text', text: 'ok' }] };
        }
        default:
          if (s.unknownMethod === 'success') return {};
          throw new RpcError('Method not found', -32601);
      }
    },
    async close() {},
  };
}

function deps(servers: Partial<Record<McpEra, FakeServer | Error>>, calls: string[] = []) {
  return {
    now: () => 1_700_000_000_000,
    async open(era: McpEra) {
      const s = servers[era];
      if (!s) throw new Error(`no ${era} server`);
      if (s instanceof Error) throw s;
      return fakeSession(s, calls);
    },
  };
}

const goodTool = {
  name: 'echo',
  description: 'Echo',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  annotations: { readOnlyHint: true },
};

const codes = (r: Awaited<ReturnType<typeof runMcpConformance>>) => r.findings.map((f) => f.code);

describe('runMcpConformance', () => {
  it('passes a clean server in both eras with no errors', async () => {
    const legacy: FakeServer = { tools: [goodTool] };
    const modern: FakeServer = { protocolVersion: '2026-07-28', tools: [goodTool] };
    const report = await runMcpConformance(deps({ legacy, modern }), { target: 'http://x/mcp' });
    expect(report.summary.errors).toBe(0);
    expect(report.eras.map((e) => [e.era, e.status])).toEqual([
      ['legacy', 'ok'],
      ['modern', 'ok'],
    ]);
    expect(report.diff?.tools).toEqual({ onlyLegacy: [], onlyModern: [], changed: [] });
    expect(report.eras[1]?.protocolVersion).toBe('2026-07-28');
  });

  it('treats an unsupported modern era as info, an unsupported legacy era as an error', async () => {
    const r1 = await runMcpConformance(deps({ legacy: {}, modern: new Error('no discover') }));
    expect(r1.eras[1]?.status).toBe('unsupported');
    expect(r1.summary.errors).toBe(0);
    expect(r1.diff).toBeNull();
    expect(codes(r1)).toContain('era.unsupported');

    const r2 = await runMcpConformance(deps({ legacy: new Error('boom'), modern: {} }));
    expect(r2.eras[0]?.status).toBe('failed');
    expect(codes(r2)).toContain('era.connect-failed');
    expect(r2.summary.errors).toBe(1);
  });

  it('supports a single-era run (web path)', async () => {
    const report = await runMcpConformance(deps({ legacy: { tools: [goodTool] } }), {
      eras: ['legacy'],
    });
    expect(report.eras).toHaveLength(1);
    expect(report.diff).toBeNull();
  });

  it('flags malformed handshake data', async () => {
    const report = await runMcpConformance(
      deps({
        legacy: {
          protocolVersion: 'latest',
          serverInfo: { name: '' },
          capabilities: { tools: 'yes', resources: { subscribe: 'true' } },
        },
      }),
      { eras: ['legacy'] }
    );
    expect(codes(report)).toEqual(
      expect.arrayContaining([
        'init.protocol-version',
        'init.server-info',
        'capabilities.malformed',
      ])
    );
  });

  it('flags missing capabilities and era/version mismatches', async () => {
    const report = await runMcpConformance(
      deps({
        legacy: { capabilities: null, protocolVersion: '2026-07-28' },
        modern: { protocolVersion: '2025-06-18' },
      })
    );
    expect(codes(report)).toEqual(
      expect.arrayContaining(['capabilities.missing', 'init.era-mismatch'])
    );
    expect(report.findings.filter((f) => f.code === 'init.era-mismatch')).toHaveLength(2);
  });

  it('flags unknown-method handling', async () => {
    const report = await runMcpConformance(deps({ legacy: { unknownMethod: 'success' } }), {
      eras: ['legacy'],
    });
    expect(codes(report)).toContain('protocol.unknown-method-accepted');
  });

  it('follows pagination and detects bad/looping cursors', async () => {
    const paged = await runMcpConformance(
      deps({
        legacy: {
          toolsPages: [[goodTool], [{ ...goodTool, name: 'b' }], [{ ...goodTool, name: 'c' }]],
        },
      }),
      { eras: ['legacy'] }
    );
    expect(paged.eras[0]?.listing.tools.map((t) => t.name)).toEqual(['echo', 'b', 'c']);

    const loop = {
      protocolVersion: '2025-06-18',
      serverCapabilities: { tools: {} },
      serverInfo: { name: 'n', version: '1' },
      async request(method: string) {
        if (method === 'tools/list') return { tools: [], nextCursor: 'same' };
        throw new RpcError('nope', -32601);
      },
      async close() {},
    };
    const looped = await runMcpConformance({ open: async () => loop }, { eras: ['legacy'] });
    expect(codes(looped)).toContain('pagination.cursor-loop');

    const badCursor = {
      ...loop,
      request: async (m: string) =>
        m === 'tools/list'
          ? { tools: [], nextCursor: '' }
          : Promise.reject(new RpcError('x', -32601)),
    };
    const bad = await runMcpConformance({ open: async () => badCursor }, { eras: ['legacy'] });
    expect(codes(bad)).toContain('pagination.bad-cursor');
  });

  it('stops at the page cap', async () => {
    let n = 0;
    const endless = {
      protocolVersion: '2025-06-18',
      serverCapabilities: { tools: {} },
      serverInfo: { name: 'n', version: '1' },
      async request(method: string) {
        if (method === 'tools/list') return { tools: [], nextCursor: `c${n++}` };
        throw new RpcError('nope', -32601);
      },
      async close() {},
    };
    const report = await runMcpConformance(
      { open: async () => endless },
      { eras: ['legacy'], maxPages: 3 }
    );
    expect(codes(report)).toContain('pagination.page-cap');
    expect(n).toBe(3);
  });

  it('detects descriptors that fail normalization or violate the spec', async () => {
    const report = await runMcpConformance(
      deps({
        legacy: {
          tools: [
            { description: 'no name' },
            { name: 'noschema' },
            { name: 'badout', inputSchema: { type: 'object' }, outputSchema: 'str' },
            { name: 'dup', inputSchema: { type: 'object' } },
            { name: 'dup', inputSchema: { type: 'object' } },
            { name: 'ann', inputSchema: { type: 'object' }, annotations: { readOnlyHint: 'yes' } },
          ],
          resources: [{ name: 'no-uri' }, { uri: 'a://1' }],
          prompts: [{ name: 'p', arguments: 'x' }, {}],
        },
      }),
      { eras: ['legacy'] }
    );
    expect(codes(report)).toEqual(
      expect.arrayContaining([
        'tools.descriptor-invalid',
        'tools.input-schema-missing',
        'tools.output-schema-malformed',
        'tools.duplicate-name',
        'tools.annotations-malformed',
        'resources.descriptor-invalid',
        'resources.name-missing',
        'prompts.arguments-malformed',
        'prompts.descriptor-invalid',
      ])
    );
  });

  describe('sample calls', () => {
    const outTool = (name: string, annotations?: object) => ({
      name,
      inputSchema: { type: 'object' },
      outputSchema: {
        type: 'object',
        properties: { n: { type: 'number' } },
        required: ['n'],
      },
      ...(annotations ? { annotations } : {}),
    });

    it('is off by default: no tools/call is made', async () => {
      const calls: string[] = [];
      await runMcpConformance(
        deps({ legacy: { tools: [outTool('t', { readOnlyHint: true })] } }, calls),
        {
          eras: ['legacy'],
        }
      );
      expect(calls).not.toContain('tools/call');
    });

    it('read-only mode calls only readOnlyHint tools, never destructive or unannotated', async () => {
      const calls: string[] = [];
      const report = await runMcpConformance(
        deps(
          {
            legacy: {
              tools: [
                outTool('ro', { readOnlyHint: true }),
                outTool('plain'),
                outTool('del', { destructiveHint: true }),
              ],
              callResults: { ro: { content: [], structuredContent: { n: 1 } } },
            },
          },
          calls
        ),
        { eras: ['legacy'], sampleCalls: 'read-only' }
      );
      expect(calls.filter((c) => c === 'tools/call')).toHaveLength(1);
      const byTool = Object.fromEntries(report.eras[0]!.samples.map((s) => [s.tool, s]));
      expect(byTool.ro?.status).toBe('ok');
      expect(byTool.ro?.outputSchema).toBe('valid');
      expect(byTool.plain?.status).toBe('skipped');
      expect(byTool.del?.reason).toMatch(/destructive/);
      expect(codes(report)).toContain('tools.output-schema-unverified');
    });

    it('selected mode calls approved non-read-only tools but never destructive ones', async () => {
      const calls: string[] = [];
      const report = await runMcpConformance(
        deps(
          {
            legacy: {
              tools: [
                outTool('plain'),
                outTool('del', { destructiveHint: true }),
                outTool('other'),
              ],
              callResults: { plain: { content: [], structuredContent: { n: 2 } } },
            },
          },
          calls
        ),
        { eras: ['legacy'], sampleCalls: 'selected', approvedTools: ['plain', 'del'] }
      );
      const called = report.eras[0]!.samples.filter((s) => s.status !== 'skipped').map(
        (s) => s.tool
      );
      expect(called).toEqual(['plain']);
    });

    it('detects structuredContent that violates the outputSchema', async () => {
      const report = await runMcpConformance(
        deps({
          legacy: {
            tools: [outTool('t', { readOnlyHint: true })],
            callResults: {
              t: { content: [{ type: 'text', text: '{}' }], structuredContent: { n: 'x' } },
            },
          },
        }),
        { eras: ['legacy'], sampleCalls: 'read-only' }
      );
      const f = report.findings.find((x) => x.code === 'tools.output-schema-mismatch');
      expect(f?.severity).toBe('error');
      expect(f?.subject).toBe('t');
      expect(report.eras[0]?.samples[0]?.outputSchema).toBe('invalid');
    });

    it('detects missing structuredContent when an outputSchema is declared', async () => {
      const report = await runMcpConformance(
        deps({
          legacy: {
            tools: [outTool('t', { readOnlyHint: true })],
            callResults: { t: { content: [{ type: 'text', text: 'hi' }] } },
          },
        }),
        { eras: ['legacy'], sampleCalls: 'read-only' }
      );
      expect(codes(report)).toContain('tools.structured-content-missing');
    });

    it('warns when structuredContent has no text block, and notes schema-less structuredContent', async () => {
      const report = await runMcpConformance(
        deps({
          legacy: {
            tools: [
              { name: 't', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
            ],
            callResults: { t: { content: [], structuredContent: { a: 1 } } },
          },
        }),
        { eras: ['legacy'], sampleCalls: 'read-only' }
      );
      expect(codes(report)).toEqual(
        expect.arrayContaining([
          'tools.structured-content-no-text',
          'tools.structured-content-no-schema',
        ])
      );
    });

    it('records tool errors, protocol errors and unsynthesizable arguments', async () => {
      const ro = { annotations: { readOnlyHint: true } };
      const report = await runMcpConformance(
        deps({
          legacy: {
            tools: [
              { name: 'iserr', inputSchema: { type: 'object' }, ...ro },
              { name: 'throws', inputSchema: { type: 'object' }, ...ro },
              { name: 'malformed', inputSchema: { type: 'object' }, ...ro },
              { name: 'empty', inputSchema: { type: 'object' }, ...ro },
              {
                name: 'needs',
                inputSchema: {
                  type: 'object',
                  properties: { x: { type: 'weird' } },
                  required: ['x'],
                },
                ...ro,
              },
            ],
            callResults: {
              iserr: { isError: true, content: [] },
              throws: new Error('kaboom'),
              malformed: 'nope',
              empty: {},
            },
          },
        }),
        { eras: ['legacy'], sampleCalls: 'read-only' }
      );
      const st = Object.fromEntries(report.eras[0]!.samples.map((s) => [s.tool, s.status]));
      expect(st).toEqual({
        iserr: 'tool-error',
        throws: 'protocol-error',
        malformed: 'protocol-error',
        empty: 'ok',
        needs: 'skipped',
      });
      expect(codes(report)).toEqual(
        expect.arrayContaining([
          'tools.sample-tool-error',
          'tools.sample-failed',
          'tools.call-result-malformed',
          'tools.call-content-missing',
          'tools.sample-skipped',
        ])
      );
    });
  });

  describe('era diff', () => {
    it('diffs capabilities, listings, descriptors and serverInfo', async () => {
      const legacy: FakeServer = {
        serverInfo: { name: 'srv', version: '1.0.0' },
        capabilities: { tools: { listChanged: true }, prompts: {}, resources: {} },
        tools: [goodTool, { ...goodTool, name: 'legacy-only' }, { ...goodTool, name: 'chg' }],
        resources: [{ uri: 'a://1', name: 'one' }],
        prompts: [{ name: 'p', description: 'old' }],
      };
      const modern: FakeServer = {
        protocolVersion: '2026-07-28',
        serverInfo: { name: 'srv', version: '2.0.0' },
        capabilities: { tools: { listChanged: false }, resources: {}, completions: {} },
        tools: [
          goodTool,
          { ...goodTool, name: 'modern-only' },
          { ...goodTool, name: 'chg', description: 'new' },
        ],
        resources: [{ uri: 'a://1', name: 'ONE' }],
        prompts: [],
      };
      const report = await runMcpConformance(deps({ legacy, modern }));
      const d = report.diff!;
      expect(d.serverInfo.differs).toBe(true);
      expect(d.capabilities).toEqual({
        onlyLegacy: ['prompts'],
        onlyModern: ['completions'],
        changed: ['tools.listChanged'],
      });
      expect(d.tools).toEqual({
        onlyLegacy: ['legacy-only'],
        onlyModern: ['modern-only'],
        changed: [{ name: 'chg', fields: ['description'] }],
      });
      expect(d.resources.changed).toEqual([{ name: 'a://1', fields: ['name'] }]);
      expect(codes(report)).toEqual(
        expect.arrayContaining(['diff.server-info', 'diff.capability', 'diff.tool'])
      );
    });
  });

  it('closes every session it opens, even when a check throws unexpectedly', async () => {
    let closed = 0;
    const session: McpConformanceSession = {
      protocolVersion: '2025-06-18',
      serverCapabilities: {},
      serverInfo: { name: 'a', version: '1' },
      request: async () => {
        throw new RpcError('x', -32601);
      },
      close: async () => {
        closed++;
      },
    };
    await runMcpConformance({ open: async () => session });
    expect(closed).toBe(2);
  });
});

describe('helpers', () => {
  it('redacts credentials and query from the target', () => {
    expect(redactConformanceTarget('https://u:p@h.example/mcp?token=abc#x')).toBe(
      'https://h.example/mcp'
    );
    expect(redactConformanceTarget('not a url')).toBe('(invalid url)');
  });

  it('synthesizes minimal samples', () => {
    expect(
      synthesizeSample({
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'integer', minimum: 3 },
          c: { enum: ['x', 'y'] },
          d: { type: 'array' },
          e: { type: 'boolean' },
          f: { type: 'null' },
          g: { const: 7 },
          h: { type: 'string', minLength: 2 },
          i: { type: 'string', default: 'dflt' },
        },
        required: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
      })
    ).toEqual({ a: '', b: 3, c: 'x', d: [], e: false, f: null, g: 7, h: 'xx', i: 'dflt' });
    expect(synthesizeSample({ type: 'weird' })).toBeUndefined();
    expect(synthesizeSample('nope')).toBeUndefined();
  });
});

describe('export', () => {
  async function sample() {
    return runMcpConformance(
      deps({
        legacy: {
          tools: [
            {
              name: 't',
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object', required: ['n'] },
              annotations: { readOnlyHint: true },
            },
          ],
          callResults: { t: { content: [], structuredContent: {} } },
        },
        modern: new Error('probe failed | with pipe'),
      }),
      { target: 'https://u:p@h.example/mcp?k=v', sampleCalls: 'read-only' }
    );
  }

  it('renders deterministic Markdown with era table, diff, findings and samples', async () => {
    const md = conformanceReportToMarkdown(await sample());
    expect(md).toContain('# MCP conformance report');
    expect(md).toContain('Target: `https://h.example/mcp`');
    expect(md).not.toContain('u:p');
    expect(md).toContain('| legacy | ok | 2025-06-18 | fake@1.0.0 | 1 | 0 | 0 |');
    expect(md).toContain('| modern | unsupported | - | - | 0 | 0 | 0 |');
    expect(md).toContain('_Not comparable: both eras must connect._');
    expect(md).toContain('| ERROR | legacy | `tools.output-schema-mismatch` | t |');
    expect(md).toContain('probe failed \\| with pipe');
    expect(md).toContain('### legacy');
    expect(md).toContain('| t | ok | invalid |');
  });

  it('renders the diff section when both eras connect', async () => {
    const report = await runMcpConformance(
      deps({
        legacy: { tools: [goodTool] },
        modern: { protocolVersion: '2026-07-28', tools: [{ ...goodTool, name: 'new' }] },
      })
    );
    const md = conformanceReportToMarkdown(report);
    expect(md).toContain('- Protocol version: 2025-06-18 vs 2026-07-28');
    expect(md).toContain('- Server info: identical');
    expect(md).toContain('only legacy: `echo`');
    expect(md).toContain('only modern: `new`');
    expect(md).toContain('- Resources: identical');
  });

  it('exports JSON that round-trips', async () => {
    const report = await sample();
    const json = conformanceReportToJson(report);
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(report)));
    expect(JSON.parse(json).schemaVersion).toBe(1);
    expect(json.endsWith('\n')).toBe(true);
  });
});

describe('markdown edge cases', () => {
  it('renders approved tools, capability/listing diffs and an empty findings section', async () => {
    const legacy: FakeServer = {
      capabilities: { tools: {}, logging: {} },
      tools: [goodTool],
      resources: [{ uri: 'a://1', name: 'one' }],
      prompts: [{ name: 'p' }],
    };
    const modern: FakeServer = {
      protocolVersion: '2026-07-28',
      serverInfo: { name: 'other', version: '2' },
      capabilities: { tools: { listChanged: true }, completions: {} },
      tools: [goodTool],
      resources: [{ uri: 'a://2', name: 'two' }],
      prompts: [{ name: 'p', description: 'd' }],
    };
    const report = await runMcpConformance(deps({ legacy, modern }), {
      sampleCalls: 'selected',
      approvedTools: ['echo'],
    });
    const md = conformanceReportToMarkdown(report);
    expect(md).toContain('(approved: echo)');
    expect(md).toContain('- Server info: differs');
    expect(md).toContain('only legacy: `logging`');
    expect(md).toContain('only modern: `completions`');

    const clean = await runMcpConformance(deps({ legacy: {}, modern: {} }), { eras: [] });
    expect(conformanceReportToMarkdown(clean)).toContain('No findings.');
  });
});

describe('defensive paths', () => {
  const raw = (over: Partial<McpConformanceSession> & { lists?: Record<string, unknown[]> }) => {
    const { lists, ...rest } = over;
    return {
      open: async () =>
        ({
          protocolVersion: '2025-06-18',
          serverCapabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: 'n', version: '1' },
          async request(method: string) {
            const queue = lists?.[method];
            if (queue) {
              const next = queue.shift();
              if (next instanceof Error) throw next;
              return next;
            }
            throw new RpcError('nf', -32601);
          },
          async close() {},
          ...rest,
        }) as McpConformanceSession,
    };
  };

  it('reports non-Error connect failures', async () => {
    const report = await runMcpConformance(
      {
        open: async () => {
          throw 'plain string';
        },
      },
      { eras: ['legacy'] }
    );
    expect(report.eras[0]?.error).toBe('plain string');
  });

  it('handles list failures on later pages, non-object results and missing arrays', async () => {
    const report = await runMcpConformance(
      raw({
        lists: {
          'tools/list': [{ tools: [], nextCursor: 'a' }, new Error('page 2 died')],
          'resources/list': ['not an object'],
          'prompts/list': [{ nope: [] }],
        },
      }),
      { eras: ['legacy'] }
    );
    expect(codes(report)).toEqual(expect.arrayContaining(['list.failed', 'list.malformed']));
    expect(report.findings.filter((f) => f.code === 'list.malformed')).toHaveLength(2);
  });

  it('survives a first-page list failure for every list', async () => {
    const e = () => new Error('down');
    const report = await runMcpConformance(
      raw({
        lists: { 'tools/list': [e()], 'resources/list': [e()], 'prompts/list': [e()] },
      }),
      { eras: ['legacy'] }
    );
    expect(report.findings.filter((f) => f.code === 'list.failed')).toHaveLength(3);
    expect(report.eras[0]?.listing).toEqual({ tools: [], resources: [], prompts: [] });
  });

  it('flags odd descriptors: non-objects, wrong schema types, duplicates, bad annotations', async () => {
    const report = await runMcpConformance(
      raw({
        lists: {
          'tools/list': [
            {
              tools: [
                null,
                { name: 'a', inputSchema: { type: 'string' }, outputSchema: { type: 'array' } },
                { name: 'b', annotations: 'x' },
                { name: 'c' },
              ],
            },
          ],
          'resources/list': [
            {
              resources: [
                'str',
                { name: 'n' },
                { uri: 'a://1', name: 'x' },
                { uri: 'a://1', name: 'y' },
              ],
            },
          ],
          'prompts/list': [{ prompts: [{ name: 'p' }, { name: 'p' }] }],
        },
      }),
      { eras: ['legacy'], sampleCalls: 'read-only' }
    );
    expect(codes(report)).toEqual(
      expect.arrayContaining([
        'tools.descriptor-invalid',
        'tools.input-schema-type',
        'tools.output-schema-type',
        'tools.annotations-malformed',
        'resources.descriptor-invalid',
        'resources.duplicate-uri',
        'prompts.duplicate-name',
      ])
    );
  });

  it('handles a non-object serverInfo, partial serverInfo and a non-standard unknown-method code', async () => {
    const bad = await runMcpConformance(
      raw({
        serverInfo: 'nope',
        request: async () => {
          throw new RpcError('invalid', -32600);
        },
      }),
      { eras: ['legacy'] }
    );
    expect(bad.eras[0]?.serverInfo).toBeUndefined();
    expect(codes(bad)).toContain('protocol.unknown-method-code');

    const partial = await runMcpConformance(raw({ serverInfo: { title: 'T' } }), {
      eras: ['legacy'],
    });
    expect(partial.eras[0]?.serverInfo).toEqual({ title: 'T' });
  });

  it('samples tools lacking an inputSchema, using schema type arrays, minimums and odd required keys', async () => {
    const ro = { annotations: { readOnlyHint: true } };
    const calls: unknown[] = [];
    const report = await runMcpConformance(
      raw({
        request: async (method: string, params?: unknown) => {
          if (method === 'tools/list')
            return {
              tools: [
                { name: 'noschema', ...ro },
                {
                  name: 'typed',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      n: { type: ['integer', 'null'], minimum: 5 },
                      m: { type: 'number' },
                    },
                    required: ['n', 'm', 7],
                  },
                  ...ro,
                },
              ],
            };
          if (method === 'tools/call') {
            calls.push(params);
            return { content: [] };
          }
          throw new RpcError('nf', -32601);
        },
      }),
      { eras: ['legacy'], sampleCalls: 'read-only' }
    );
    expect(report.eras[0]?.samples.map((s) => s.status)).toEqual(['ok', 'ok']);
    expect(calls[1]).toEqual({ name: 'typed', arguments: { n: 5, m: 0 } });
  });

  it('renders placeholders when protocol versions and serverInfo are missing', async () => {
    const mk = (serverInfo: unknown, protocolVersion: string) =>
      raw({ serverInfo, protocolVersion, serverCapabilities: {} });
    const sessions = [mk({ version: '1' }, ''), mk({}, '2026-07-28')];
    const report = await runMcpConformance(
      { open: async (era) => sessions[era === 'legacy' ? 0 : 1]!.open() },
      { eras: ['legacy', 'modern'] }
    );
    expect(report.diff?.serverInfo.differs).toBe(true);
    const md = conformanceReportToMarkdown({ ...report, target: '' });
    expect(md).toContain('Target: `unknown`');
    expect(md).toContain('- Protocol version: - vs 2026-07-28');
    expect(md).toContain('?@1');
  });
});

describe('descriptor and diff details', () => {
  it('keeps mimeType and prompt arguments, tolerates non-object prompts', async () => {
    const server = {
      protocolVersion: '2025-06-18',
      serverCapabilities: { resources: {}, prompts: {} },
      serverInfo: { name: 'n', version: '1' },
      async request(method: string) {
        if (method === 'resources/list') {
          return { resources: [{ uri: 'a://1', name: 'one', mimeType: 'text/plain' }] };
        }
        if (method === 'prompts/list') {
          return { prompts: ['junk', { name: 'p', arguments: [{ name: 'x' }] }] };
        }
        throw new RpcError('nf', -32601);
      },
      async close() {},
    };
    const report = await runMcpConformance({ open: async () => server }, { eras: ['legacy'] });
    expect(report.eras[0]?.listing.resources[0]?.mimeType).toBe('text/plain');
    expect(report.eras[0]?.listing.prompts.map((p) => [p.name, Object.keys(p.fields)])).toEqual([
      ['p', ['arguments']],
    ]);
  });

  it('diffs array-valued descriptor fields and partial serverInfo', async () => {
    const sess = (serverInfo: unknown, protocolVersion: string, required: string[]) => ({
      protocolVersion,
      serverCapabilities: { tools: {} },
      serverInfo,
      async request(method: string) {
        if (method === 'tools/list') {
          return { tools: [{ name: 't', inputSchema: { type: 'object', required } }] };
        }
        throw new RpcError('nf', -32601);
      },
      async close() {},
    });
    const byEra = {
      legacy: sess({ name: 'only-name' }, '2025-06-18', ['a']),
      modern: sess(undefined, '', ['a', 'b']),
    };
    const report = await runMcpConformance({ open: async (e) => byEra[e] });
    expect(report.diff?.serverInfo).toEqual({ legacy: 'only-name@?', differs: true });
    expect(report.diff?.tools.changed).toEqual([{ name: 't', fields: ['inputSchema'] }]);
    expect(report.findings.find((f) => f.code === 'diff.server-info')?.message).toContain(
      'modern none'
    );

    const sameLen = { ...byEra, modern: sess({ name: 'x', version: '1' }, '2026-07-28', ['z']) };
    const r2 = await runMcpConformance({ open: async (e) => sameLen[e] });
    expect(r2.diff?.tools.changed).toEqual([{ name: 't', fields: ['inputSchema'] }]);
  });
});
