import { describe, expect, it } from 'vitest';
import { MCP_IMPORT_LIMITS, parseMcpConfigText } from './mcp-config-parser';
import { toPreviewEntry } from './mcp-import-model';

const one = (server: unknown, extra: Record<string, unknown> = {}) =>
  parseMcpConfigText(JSON.stringify({ mcpServers: { s: server }, ...extra }));

describe('parseMcpConfigText edge cases', () => {
  it('maps transport spellings and the transport field', () => {
    expect(one({ url: 'https://a', transport: 'sse' }).entries[0]).toMatchObject({
      transport: 'http-sse',
    });
    expect(one({ url: 'https://a', type: 'STREAMABLE-HTTP' }).entries[0]).toMatchObject({
      transport: 'streamable-http',
    });
    expect(one({ url: 'https://a', type: 'streamablehttp' }).entries[0]).toMatchObject({
      transport: 'streamable-http',
    });
    expect(one({ url: 'https://a', type: 'http-sse' }).entries[0]).toMatchObject({
      transport: 'http-sse',
    });
    expect(one({ command: 'x', url: 'https://a' }).entries[0]).toMatchObject({ kind: 'http' });
    expect(one({ url: 'https://a', transport: 'carrier-pigeon' }).entries[0]).toMatchObject({
      kind: 'invalid',
      reason: expect.stringContaining('Unsupported server type'),
    });
    expect(one({ type: 'weird' }).entries[0]).toMatchObject({ kind: 'invalid' });
  });

  it('validates stdio entries', () => {
    expect(one({ type: 'stdio' }).entries[0]).toMatchObject({ kind: 'invalid' });
    expect(one({ command: 'x', args: 'a' }).entries[0]).toMatchObject({ kind: 'invalid' });
    expect(
      one({ command: 'x', args: Array.from({ length: MCP_IMPORT_LIMITS.maxArgs + 1 }, () => 'a') })
        .entries[0]
    ).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('Too many') });
    expect(one({ command: 'x', args: [1, true] }).entries[0]).toMatchObject({
      kind: 'stdio',
      args: ['1', 'true'],
    });
  });

  it('reads cwd, envFile, env limits and bad env shapes', () => {
    const e = one({ command: 'x', cwd: '/abs', envFile: '.env' }).entries[0];
    expect(e).toMatchObject({ kind: 'stdio', cwd: '/abs' });
    expect(e?.warnings.join()).toContain('envFile');
    expect(one({ command: 'x', cwd: '' }).entries[0]).not.toHaveProperty('cwd');
    expect(one({ command: 'x', env: 'nope' }).entries[0]?.warnings.join()).toContain(
      'env must be an object'
    );
    expect(one({ command: 'x', env: null }).entries[0]).toMatchObject({ env: [] });
    const many: Record<string, string> = {};
    for (let i = 0; i < MCP_IMPORT_LIMITS.maxEnvEntries + 5; i++) many[`V${i}`] = 'v';
    const capped = one({ command: 'x', env: many }).entries[0];
    expect(capped?.kind === 'stdio' && capped.env).toHaveLength(MCP_IMPORT_LIMITS.maxEnvEntries);
    expect(capped?.warnings.join()).toContain('limited to');
    const polluted = parseMcpConfigText(
      '{"mcpServers":{"s":{"command":"x","env":{"__proto__":"y","OK":"1"}}}}'
    ).entries[0];
    expect(polluted?.kind === 'stdio' && polluted.env).toEqual([{ name: 'OK', value: '1' }]);
  });

  it('validates http entries', () => {
    expect(one({ type: 'http' }).entries[0]).toMatchObject({
      kind: 'invalid',
      reason: 'HTTP entry has no url',
    });
    expect(one({ url: 'ftp://x' }).entries[0]).toMatchObject({ kind: 'invalid' });
    expect(one({ url: '{{BASE}}/mcp' }).entries[0]).toMatchObject({ kind: 'http' });
  });

  it('names unnamed servers by position', () => {
    const cfg = parseMcpConfigText('{"mcpServers":{"\\u200b":{"command":"x"}}}');
    expect(cfg.entries[0]?.name).toBe('server-1');
  });

  it('handles server lists in settings.json spellings and non-object lists', () => {
    const dotted = parseMcpConfigText('{"mcp.servers":{"a":{"command":"x"}}}');
    expect(dotted.formats).toEqual(['vscode-settings']);
    const both = parseMcpConfigText('{"mcpServers":[],"servers":{"a":{"command":"x"}}}');
    expect(both.formats).toEqual(['vscode']);
    expect(both.warnings.join()).toContain('not an object');
  });

  it('reports inputs problems and unresolved placeholders', () => {
    const bad = one({ command: 'x' }, { inputs: 'nope' });
    expect(bad.warnings.join()).toContain('inputs must be an array');
    const cfg = one(
      { command: 'x', args: ['${input:missing}', '${workspaceFolder}', '${input:known}'] },
      { inputs: [{ id: 'known' }, { id: '' }, 'x', { id: 'unused', description: 'd' }] }
    );
    const warnings = cfg.warnings.join('\n');
    expect(warnings).toContain('${input:missing} has no matching entry');
    expect(warnings).toContain('Input "known" maps to');
    expect(cfg.inputs.map((i) => i.id)).toEqual(['known', 'unused']);
    expect(cfg.entries[0]?.warnings.join()).toContain('${workspaceFolder}');
  });

  it('treats enabled:false as disabled and strips a BOM', () => {
    const cfg = parseMcpConfigText('﻿{"mcpServers":{"a":{"command":"x","enabled":false}}}');
    expect(cfg.entries[0]?.disabled).toBe(true);
  });
});

describe('toPreviewEntry', () => {
  it('shows stdio cwd and hides handle-backed env', () => {
    const entry = one({ command: 'x', cwd: '/abs', env: { A_TOKEN: 's', B: 'b' } }).entries[0];
    if (!entry) throw new Error('missing');
    const preview = toPreviewEntry(entry, 'k.', (row) => row.name === 'A_TOKEN');
    expect(preview).toMatchObject({ key: 'k.0', kind: 'stdio', cwd: '/abs' });
    expect(preview.env).toEqual([
      { name: 'A_TOKEN', secret: true },
      { name: 'B', value: 'b', secret: false },
    ]);
  });

  it('marks invalid entries with their reason', () => {
    const entry = one('nope').entries[0];
    if (!entry) throw new Error('missing');
    expect(toPreviewEntry(entry, '', () => false)).toMatchObject({
      kind: 'invalid',
      reason: 'Entry is not an object',
    });
  });
});
