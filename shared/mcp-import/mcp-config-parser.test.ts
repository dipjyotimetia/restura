import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MCP_IMPORT_LIMITS,
  McpConfigParseError,
  parseMcpConfigText,
  sanitizeImportLabel,
} from './mcp-config-parser';
import { buildHttpDraft, isPlaceholderOnly, toPreviewEntry } from './mcp-import-model';

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');

describe('parseMcpConfigText', () => {
  it('parses Claude Desktop mcpServers (stdio entries)', () => {
    const cfg = parseMcpConfigText(fixture('claude_desktop_config.json'));
    expect(cfg.formats).toEqual(['mcpServers']);
    expect(cfg.entries.map((e) => [e.name, e.kind])).toEqual([
      ['filesystem', 'stdio'],
      ['github', 'stdio'],
    ]);
    const gh = cfg.entries[1];
    expect(gh?.kind === 'stdio' && gh.env.map((e) => e.name)).toEqual([
      'GITHUB_PERSONAL_ACCESS_TOKEN',
      'LOG_LEVEL',
      'NODE_OPTIONS',
    ]);
  });

  it('parses Cursor mcp.json: sse type, url-only default, ${env:} mapped not read', () => {
    process.env.EXAMPLE_KEY = 'host-secret-must-not-leak';
    const cfg = parseMcpConfigText(fixture('cursor_mcp.json'));
    const [sse, http, local] = cfg.entries;
    expect(sse).toMatchObject({
      kind: 'http',
      transport: 'http-sse',
      url: 'https://mcp.example.com/sse',
    });
    expect(http).toMatchObject({ kind: 'http', transport: 'streamable-http' });
    expect(http?.kind === 'http' && http.headers[0]?.value).toBe('{{EXAMPLE_KEY}}');
    expect(JSON.stringify(cfg)).not.toContain('host-secret-must-not-leak');
    expect(local?.kind === 'stdio' && local.env[0]?.value).toBe('{{LOCAL_KEY}}');
    expect(http?.warnings.join()).toContain('was not read from this machine');
    delete process.env.EXAMPLE_KEY;
  });

  it('parses VS Code mcp.json (JSONC, inputs, type http) and flags unsupported types', () => {
    const cfg = parseMcpConfigText(fixture('vscode_mcp.jsonc'));
    expect(cfg.formats).toEqual(['vscode']);
    expect(cfg.inputs).toEqual([
      { id: 'perplexity-key', description: 'Perplexity API Key', password: true },
    ]);
    const [stdio, http, weird] = cfg.entries;
    expect(stdio?.kind === 'stdio' && stdio.env[0]?.value).toBe('{{perplexity-key}}');
    expect(stdio?.kind === 'stdio' && stdio.cwd).toBe('${workspaceFolder}');
    expect(http).toMatchObject({ kind: 'http', transport: 'streamable-http' });
    expect(http?.kind === 'http' && http.headers[0]?.value).toBe('Bearer {{perplexity-key}}');
    expect(weird).toMatchObject({ kind: 'invalid' });
    expect(cfg.warnings.join()).toContain('perplexity-key');
  });

  it('parses VS Code settings.json mcp.servers', () => {
    const cfg = parseMcpConfigText(fixture('vscode_settings.json'));
    expect(cfg.formats).toEqual(['vscode-settings']);
    expect(cfg.entries).toHaveLength(1);
    expect(cfg.entries[0]).toMatchObject({ kind: 'stdio', command: 'uvx' });
  });

  it.each([
    ['not json', '{nope'],
    ['empty', ''],
    ['array root', '[]'],
    ['no server map', '{"foo":1}'],
  ])('rejects %s', (_n, text) => {
    expect(() => parseMcpConfigText(text)).toThrow(McpConfigParseError);
  });

  it('rejects oversize input and too many servers', () => {
    expect(() =>
      parseMcpConfigText(`{"mcpServers":{},"pad":"${'a'.repeat(MCP_IMPORT_LIMITS.maxBytes)}"}`)
    ).toThrow(/larger than/);
    const many: Record<string, unknown> = {};
    for (let i = 0; i <= MCP_IMPORT_LIMITS.maxServers; i++) many[`s${i}`] = { command: 'x' };
    expect(() => parseMcpConfigText(JSON.stringify({ mcpServers: many }))).toThrow(/More than/);
  });

  it('marks malformed entries invalid instead of throwing', () => {
    const cfg = parseMcpConfigText(
      JSON.stringify({
        mcpServers: {
          a: 'string',
          b: { command: 'x', args: 'not-array' },
          c: { url: 'ftp://x' },
          d: { type: 'stdio' },
          e: { command: 'x', args: [{}] },
          f: { url: 'https://ok', headers: { A: { nested: 1 }, B: 2 } },
        },
      })
    );
    expect(cfg.entries.map((e) => e.kind)).toEqual([
      'invalid',
      'invalid',
      'invalid',
      'invalid',
      'invalid',
      'http',
    ]);
    const f = cfg.entries[5];
    expect(f?.kind === 'http' && f.headers).toEqual([{ name: 'B', value: '2' }]);
  });

  it('ignores prototype-polluting keys and sanitises names', () => {
    const cfg = parseMcpConfigText(
      '{"mcpServers":{"__proto__":{"command":"x"},"ev\\u202eil":{"command":"x"}}}'
    );
    expect(cfg.entries.map((e) => e.name)).toEqual(['evil']);
    expect(({} as Record<string, unknown>).command).toBeUndefined();
  });

  it('flags disabled entries', () => {
    const cfg = parseMcpConfigText('{"mcpServers":{"a":{"command":"x","disabled":true}}}');
    expect(cfg.entries[0]?.disabled).toBe(true);
  });
});

describe('sanitizeImportLabel', () => {
  it('strips Cc/Cf/Zl/Zp and clamps', () => {
    expect(sanitizeImportLabel('a‮b​c d\u0085e\nf')).toBe('abc de f');
    expect(sanitizeImportLabel('x'.repeat(500)).length).toBe(MCP_IMPORT_LIMITS.maxNameLength);
  });
});

describe('preview + http drafts', () => {
  it('omits secret-looking header values from previews and flags them on drafts', () => {
    const cfg = parseMcpConfigText(fixture('cursor_mcp.json'));
    const sse = cfg.entries[0];
    if (sse?.kind !== 'http') throw new Error('expected http');
    const preview = toPreviewEntry(sse, '0.', () => false);
    expect(JSON.stringify(preview)).not.toContain('abc123');
    expect(preview.headers).toEqual([
      { name: 'Authorization', secret: true },
      { name: 'X-Team', value: 'core', secret: false },
    ]);
    const draft = buildHttpDraft(sse);
    expect(draft.headers[0]).toMatchObject({ key: 'Authorization', secret: true });
  });

  it('treats a {{var}} reference as plain, not secret', () => {
    expect(isPlaceholderOnly('{{A}}')).toBe(true);
    expect(isPlaceholderOnly('Bearer {{A}}')).toBe(false);
  });
});
