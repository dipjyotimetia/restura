import { describe, expect, it } from 'vitest';
import { mcpStdioFromOC, mcpStdioToOC, mcpTransportFromOC } from './mcp-stdio-extension';

describe('MCP stdio OpenCollection carriage', () => {
  it('falls back to streamable-http for unknown transports', () => {
    expect(mcpTransportFromOC('stdio')).toBe('stdio');
    expect(mcpTransportFromOC('http-sse')).toBe('http-sse');
    expect(mcpTransportFromOC('websocket')).toBe('streamable-http');
    expect(mcpTransportFromOC(undefined)).toBe('streamable-http');
  });

  it('ignores malformed stdio blocks and junk entries', () => {
    expect(mcpStdioFromOC(undefined)).toBeUndefined();
    expect(mcpStdioFromOC('npx')).toBeUndefined();
    expect(mcpStdioFromOC({ args: ['x'] })).toBeUndefined();
    const parsed = mcpStdioFromOC({
      command: 'npx',
      args: ['-y', 3, null, 'srv'],
      cwd: 7,
      env: [
        null,
        { value: 'no-name' },
        { key: 'LEGACY_KEY', value: 'v' },
        { name: 'BAD_REF', value: 'x', secretRef: { kind: 'bogus' } },
        { name: 'NUM', value: 5 },
      ],
    });
    expect(parsed?.args).toEqual(['-y', 'srv']);
    expect(parsed?.cwd).toBeUndefined();
    expect(parsed?.env?.map((e) => [e.key, e.value, e.secretRef])).toEqual([
      ['LEGACY_KEY', 'v', undefined],
      ['BAD_REF', 'x', undefined],
      ['NUM', '', undefined],
    ]);
  });

  it('drops an env list with no valid entries and does not emit an empty env', () => {
    expect(mcpStdioFromOC({ command: 'srv', env: [null] })).toEqual({ command: 'srv', args: [] });
    expect(mcpStdioToOC({ command: 'srv', args: [], env: [] })).toEqual({
      command: 'srv',
      args: [],
    });
  });

  it('round-trips the secret flag', () => {
    const parsed = mcpStdioFromOC({
      command: 'srv',
      env: [{ name: 'API_KEY', value: '', secret: true }],
    });
    expect(parsed?.env?.[0]).toMatchObject({ key: 'API_KEY', value: '', secret: true });
    const oc = mcpStdioToOC(parsed!);
    expect(oc.env).toEqual([{ name: 'API_KEY', value: '', secret: true }]);
  });

  it('carries no consent state: an imported approval flag is dropped', () => {
    const parsed = mcpStdioFromOC({ command: 'srv', approved: true, consentKey: 'abc' });
    expect(parsed).toEqual({ command: 'srv', args: [] });
  });
});
