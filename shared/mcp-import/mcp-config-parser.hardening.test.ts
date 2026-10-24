import { describe, expect, it } from 'vitest';
import { MCP_IMPORT_LIMITS, parseMcpConfigText } from './mcp-config-parser';
import { maskArgsForPreview, maskUrlForPreview, toPreviewEntry } from './mcp-import-model';

const one = (server: unknown) => parseMcpConfigText(JSON.stringify({ mcpServers: { s: server } }));
const MASK = '•••';

describe('warning flood is bounded (M1)', () => {
  it('collapses ~1 MB of distinct ${x} placeholders into a capped warning list', () => {
    const env: Record<string, string> = {};
    for (let e = 0; e < 30; e++) {
      let value = '';
      for (let i = 0; value.length < 30000; i++) value += `\${v${e}_${i}}`;
      env[`E${e}`] = value;
    }
    const cfg = one({ command: 'x', env });
    const entry = cfg.entries[0];
    expect(entry?.warnings.length).toBeLessThanOrEqual(MCP_IMPORT_LIMITS.maxEntryWarnings + 1);
    expect(entry?.warnings.at(-1)).toMatch(/^and \d+ more warnings$/);
    if (entry?.kind !== 'stdio') throw new Error('expected stdio');
    const preview = toPreviewEntry(entry, '0.', () => false);
    expect(preview.warnings.length).toBeLessThanOrEqual(MCP_IMPORT_LIMITS.maxEntryWarnings + 1);
  });

  it('deduplicates identical warnings', () => {
    const entry = one({ command: 'x', args: ['${a}', '${a}', '${a}'] }).entries[0];
    expect(entry?.warnings).toHaveLength(1);
  });

  it('caps the number of global input warnings', () => {
    const servers = Object.fromEntries(
      Array.from({ length: 5 }, (_v, i) => [
        `s${i}`,
        { command: 'x', args: Array.from({ length: 120 }, (_w, j) => `\${input:s${i}_${j}}`) },
      ])
    );
    const cfg = parseMcpConfigText(JSON.stringify({ servers }));
    expect(cfg.warnings.length).toBeLessThanOrEqual(MCP_IMPORT_LIMITS.maxWarnings);
    expect(cfg.warnings.length).toBeGreaterThan(100);
  });
});

describe('parse-time length caps (M1)', () => {
  it('rejects overlong command, args, url and drops overlong cwd / env values', () => {
    expect(
      one({ command: 'a'.repeat(MCP_IMPORT_LIMITS.maxCommandLength + 1) }).entries[0]
    ).toMatchObject({
      kind: 'invalid',
    });
    expect(
      one({ command: 'x', args: ['a'.repeat(MCP_IMPORT_LIMITS.maxArgLength + 1)] }).entries[0]
    ).toMatchObject({ kind: 'invalid', reason: 'arguments are too long' });
    const many = Array.from({ length: 9 }, () => 'a'.repeat(MCP_IMPORT_LIMITS.maxArgLength));
    expect(one({ command: 'x', args: many }).entries[0]).toMatchObject({ kind: 'invalid' });
    expect(
      one({ url: `https://a.test/${'a'.repeat(MCP_IMPORT_LIMITS.maxUrlLength)}` }).entries[0]
    ).toMatchObject({ kind: 'invalid', reason: 'url is too long' });

    const e = one({
      command: 'x',
      cwd: `/${'a'.repeat(MCP_IMPORT_LIMITS.maxCwdLength)}`,
      env: {
        BIG: 'v'.repeat(MCP_IMPORT_LIMITS.maxValueLength + 1),
        [`N${'x'.repeat(300)}`]: '1',
        OK: '1',
      },
    }).entries[0];
    if (e?.kind !== 'stdio') throw new Error('expected stdio');
    expect(e.cwd).toBeUndefined();
    expect(e.env).toEqual([{ name: 'OK', value: '1' }]);
    expect(e.warnings.join()).toContain('Working directory is too long');
  });
});

describe('own-property reads (L5)', () => {
  it('ignores inherited properties from a polluted prototype', () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    proto.url = 'https://evil.test/mcp';
    proto.mcpServers = { evil: { command: 'rm' } };
    try {
      expect(one({ type: 'http' }).entries[0]).toMatchObject({
        kind: 'invalid',
        reason: 'HTTP entry has no url',
      });
      expect(() => parseMcpConfigText('{"foo":1}')).toThrow(/No MCP servers/);
    } finally {
      delete proto.url;
      delete proto.mcpServers;
    }
  });
});

describe('preview masking (M2)', () => {
  it('masks credential flags, --flag=value and Bearer/Basic literals', () => {
    const r = maskArgsForPreview([
      '--api-key',
      'sk-live-1',
      '--token=abc',
      '-p',
      'keepme',
      '--password',
      'Authorization: Bearer abc.def',
      'Basic dXNlcjpwYXNz',
      '--verbose',
    ]);
    expect(r.masked).toBe(true);
    expect(r.args).toEqual([
      '--api-key',
      MASK,
      `--token=${MASK}`,
      '-p',
      'keepme',
      '--password',
      MASK,
      `Basic ${MASK}`,
      '--verbose',
    ]);
    expect(maskArgsForPreview(['Authorization: Bearer abc']).args).toEqual([
      `Authorization: Bearer ${MASK}`,
    ]);
    expect(maskArgsForPreview(['-y', 'pkg', '--port=1']).masked).toBe(false);
  });

  it('masks URL userinfo and credential query params, keeps the rest and {{vars}}', () => {
    expect(
      maskUrlForPreview('https://u:p@host.test/mcp?api_key=SECRET&x=1&token={{T}}&k=')
    ).toEqual({
      url: `https://${MASK}@host.test/mcp?api_key=${MASK}&x=1&token={{T}}&k=`,
      masked: true,
    });
    expect(maskUrlForPreview('https://host.test/mcp?%E0%A4%A=1&access_token=z').url).toBe(
      `https://host.test/mcp?%E0%A4%A=1&access_token=${MASK}`
    );
    expect(maskUrlForPreview('https://host.test/a?b=c')).toEqual({
      url: 'https://host.test/a?b=c',
      masked: false,
    });
  });

  it('adds explicit warnings to the previews', () => {
    const http = one({ url: 'https://h.test/mcp?token=abc' }).entries[0];
    const stdio = one({ command: 'x', args: ['--secret', 'abc'] }).entries[0];
    if (!http || !stdio) throw new Error('missing');
    const hp = toPreviewEntry(http, '', () => false);
    const sp = toPreviewEntry(stdio, '', () => false);
    expect(hp.url).toBe(`https://h.test/mcp?token=${MASK}`);
    expect(hp.warnings.join()).toContain('URL contains credentials');
    expect(sp.args).toEqual(['--secret', MASK]);
    expect(sp.warnings.join()).toContain('look like credentials');
    // The parsed (imported) values are untouched.
    expect(stdio.kind === 'stdio' && stdio.args).toEqual(['--secret', 'abc']);
    expect(http.kind === 'http' && http.url).toBe('https://h.test/mcp?token=abc');
  });
});
