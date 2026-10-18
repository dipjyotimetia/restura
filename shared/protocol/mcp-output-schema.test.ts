import { describe, expect, it } from 'vitest';
import { validateAgainstSchema, validateToolOutput } from './mcp-output-schema';
import { classifyMcpOutcome, isMcpToolError, mcpToolErrorText } from './mcp-result';
import {
  isDestructiveTool,
  mcpToolDisplayName,
  normalizeMcpToolDescriptor,
} from './mcp-tool-descriptor';

const schema = {
  type: 'object',
  required: ['count', 'items'],
  additionalProperties: false,
  properties: {
    count: { type: 'integer', minimum: 0 },
    items: { type: 'array', items: { type: 'string', pattern: '^a' } },
    mode: { enum: ['x', 'y'] },
  },
};

describe('validateToolOutput', () => {
  it('is valid for conforming structuredContent', () => {
    expect(
      validateToolOutput(schema, { structuredContent: { count: 2, items: ['ab'], mode: 'x' } })
    ).toEqual({ status: 'valid' });
  });

  it('flags type, required, enum, pattern and additionalProperties mismatches with paths', () => {
    const res = validateToolOutput(schema, {
      structuredContent: { count: 1.5, items: ['ba'], mode: 'z', extra: 1 },
    });
    expect(res.status).toBe('invalid');
    const paths = res.status === 'invalid' ? res.issues.map((i) => i.path) : [];
    expect(paths).toEqual(expect.arrayContaining(['$.count', '$.items[0]', '$.mode', '$.extra']));
    const missing = validateAgainstSchema(schema, { count: 1 });
    expect(missing).toEqual([{ path: '$.items', message: 'required property is missing' }]);
  });

  it('reports missing structuredContent when an outputSchema is declared', () => {
    expect(validateToolOutput(schema, { content: [] }).status).toBe('missing');
  });

  it('skips when no schema is declared or the result is a tool error', () => {
    expect(validateToolOutput(undefined, { structuredContent: {} }).status).toBe('no-schema');
    expect(validateToolOutput(schema, { isError: true, content: [] }).status).toBe('no-schema');
  });

  it('handles anyOf/oneOf/allOf, local $ref and ignores remote refs', () => {
    const s = {
      $defs: { n: { type: 'number' } },
      anyOf: [{ $ref: '#/$defs/n' }, { type: 'string' }],
    };
    expect(validateAgainstSchema(s, 3)).toEqual([]);
    expect(validateAgainstSchema(s, true)).toHaveLength(1);
    expect(validateAgainstSchema({ $ref: 'https://evil.test/x' }, 1)).toEqual([]);
    expect(validateAgainstSchema({ oneOf: [{ type: 'number' }, { minimum: 0 }] }, 1)).toHaveLength(
      1
    );
  });

  it('never throws on hostile input (bad regex, cyclic $ref)', () => {
    expect(validateAgainstSchema({ type: 'string', pattern: '(' }, 'a')).toEqual([]);
    const cyc = { $ref: '#' };
    expect(() => validateAgainstSchema(cyc, 1)).not.toThrow();
  });
});

describe('mcp-result', () => {
  it('distinguishes protocol errors from tool errors', () => {
    expect(classifyMcpOutcome({ error: 'boom' })).toBe('protocol-error');
    expect(classifyMcpOutcome({ jsonRpcError: { code: -1 } })).toBe('protocol-error');
    expect(classifyMcpOutcome({ result: { isError: true, content: [] } })).toBe('tool-error');
    expect(classifyMcpOutcome({ result: { isError: false } })).toBe('ok');
    expect(isMcpToolError('x')).toBe(false);
    expect(mcpToolErrorText({ content: [{ type: 'text', text: 'bad' }] })).toBe('bad');
    expect(mcpToolErrorText({})).toBe('tool reported isError');
    expect(mcpToolErrorText(null)).toBe('tool reported isError');
    expect(
      mcpToolErrorText({
        content: [
          { type: 'image' },
          null,
          { type: 'text', text: 'a' },
          { type: 'text' },
          { type: 'text', text: 'b' },
        ],
      })
    ).toBe('a b');
    expect(mcpToolErrorText({ content: [{ type: 'image' }] })).toBe('tool reported isError');
  });
});

describe('normalizeMcpToolDescriptor', () => {
  it('maps title, outputSchema and boolean annotations; falls back to annotations.title', () => {
    const t = normalizeMcpToolDescriptor({
      name: 'a',
      outputSchema: { type: 'object' },
      annotations: { title: 'Nice', readOnlyHint: true, idempotentHint: 'yes' },
    });
    expect(t).toEqual({
      name: 'a',
      title: 'Nice',
      outputSchema: { type: 'object' },
      annotations: { title: 'Nice', readOnlyHint: true },
    });
    expect(mcpToolDisplayName(t!)).toBe('Nice');
  });

  it('rejects entries without a name and non-object schemas', () => {
    expect(normalizeMcpToolDescriptor({ description: 'x' })).toBeNull();
    expect(normalizeMcpToolDescriptor({ name: 'a', inputSchema: 'x', outputSchema: [] })).toEqual({
      name: 'a',
    });
  });

  it('only flags explicitly destructive, non-read-only tools', () => {
    expect(isDestructiveTool({})).toBe(false);
    expect(isDestructiveTool({ annotations: { destructiveHint: true } })).toBe(true);
    expect(isDestructiveTool({ annotations: { destructiveHint: true, readOnlyHint: true } })).toBe(
      false
    );
  });
});
