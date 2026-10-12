import { describe, expect, it } from 'vitest';
import { type McpOperation, parseMcpOperation, serializeMcpOperation } from '../mcpOperation';

describe('mcpOperation', () => {
  const cases: McpOperation[] = [
    { kind: 'tool', name: 'search', arguments: { q: 'x', limit: 5, opts: { deep: true } } },
    { kind: 'tool', name: 'no-args-yet' },
    { kind: 'prompt', name: 'greet', arguments: { who: 'Ada' } },
    { kind: 'resource', uri: 'file:///readme.md' },
  ];

  it.each(cases)('round-trips $kind through defaultMethod/defaultParams', (operation) => {
    expect(parseMcpOperation(serializeMcpOperation(operation))).toEqual(operation);
  });

  it('writes the JSON-RPC method and params the CLI sends', () => {
    expect(serializeMcpOperation({ kind: 'tool', name: 'search', arguments: { q: 'x' } })).toEqual({
      defaultMethod: 'tools/call',
      defaultParams: JSON.stringify({ name: 'search', arguments: { q: 'x' } }, null, 2),
    });
    expect(serializeMcpOperation({ kind: 'resource', uri: 'r://1' }).defaultMethod).toBe(
      'resources/read'
    );
    expect(serializeMcpOperation({ kind: 'prompt', name: 'p' }).defaultMethod).toBe('prompts/get');
  });

  it('ignores absent, malformed or non-builder operations', () => {
    expect(parseMcpOperation({})).toBeNull();
    expect(parseMcpOperation({ defaultMethod: 'ping' })).toBeNull();
    expect(parseMcpOperation({ defaultMethod: 'tools/call', defaultParams: '{oops' })).toBeNull();
    expect(parseMcpOperation({ defaultMethod: 'tools/call', defaultParams: '[]' })).toBeNull();
    expect(parseMcpOperation({ defaultMethod: 'tools/call', defaultParams: '{}' })).toBeNull();
  });

  it('coerces non-string prompt arguments to strings (prompts/get takes strings)', () => {
    expect(
      parseMcpOperation({
        defaultMethod: 'prompts/get',
        defaultParams: JSON.stringify({ name: 'p', arguments: { n: 3 } }),
      })
    ).toEqual({ kind: 'prompt', name: 'p', arguments: { n: '3' } });
  });
});
