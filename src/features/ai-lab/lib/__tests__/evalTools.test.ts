import { describe, expect, it } from 'vitest';
import { parseToolsJson, upsertTool } from '../evalTools';

describe('parseToolsJson', () => {
  it('treats blank text as no tools', () => {
    expect(parseToolsJson('  ')).toEqual({ ok: true, tools: [] });
  });

  it('parses valid tool definitions and defaults the description', () => {
    expect(parseToolsJson('[{"name":"a","inputSchema":{"type":"object"}}]')).toEqual({
      ok: true,
      tools: [{ name: 'a', description: '', inputSchema: { type: 'object' } }],
    });
  });

  it.each([
    ['{', /Invalid JSON/],
    ['{}', /JSON array/],
    ['[1]', /must be an object/],
    ['[{"inputSchema":{}}]', /non-empty "name"/],
    ['[{"name":"a"}]', /"inputSchema" must be/],
    ['[{"name":"a","inputSchema":[]}]', /"inputSchema" must be/],
    ['[{"name":"a","description":1,"inputSchema":{}}]', /"description" must be a string/],
    ['[{"name":"a","inputSchema":{}},{"name":"a","inputSchema":{}}]', /Duplicate/],
  ])('rejects %s', (text, message) => {
    const parsed = parseToolsJson(text);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.error).toMatch(message);
  });
});

describe('upsertTool', () => {
  const tool = (name: string, description = '') => ({ name, description, inputSchema: {} });
  it('appends new tools and replaces by name', () => {
    expect(upsertTool([tool('a')], tool('b'))).toEqual([tool('a'), tool('b')]);
    expect(upsertTool([tool('a'), tool('b')], tool('a', 'new'))).toEqual([
      tool('a', 'new'),
      tool('b'),
    ]);
  });
});
