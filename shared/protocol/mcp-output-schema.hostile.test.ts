import { describe, expect, it } from 'vitest';
import {
  checkAgainstSchema,
  MCP_SCHEMA_TOO_COMPLEX,
  validateAgainstSchema,
  validateToolOutput,
} from './mcp-output-schema';

function timed<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

describe('hostile server-controlled schemas stay bounded', () => {
  it('self-referential allOf of $ref "#" x10 completes fast without expanding exponentially', () => {
    const schema = { allOf: Array.from({ length: 10 }, () => ({ $ref: '#' })) };
    const { result, ms } = timed(() => checkAgainstSchema(schema, { a: 1 }));
    expect(ms).toBeLessThan(200);
    expect(result.issues).toEqual([]);
  });

  it('a chain of distinct $defs each fanning out 10x trips the step budget', () => {
    const defs: Record<string, unknown> = {};
    const depth = 12;
    for (let i = 0; i < depth; i++) {
      defs[`d${i}`] =
        i === depth - 1
          ? { type: 'object' }
          : { allOf: Array.from({ length: 10 }, () => ({ $ref: `#/$defs/d${i + 1}` })) };
    }
    const schema = { $defs: defs, $ref: '#/$defs/d0' };
    const { result, ms } = timed(() => checkAgainstSchema(schema, {}));
    expect(ms).toBeLessThan(200);
    expect(result.tooComplex).toBe(true);
    expect(result.issues).toEqual([{ path: '$', message: MCP_SCHEMA_TOO_COMPLEX }]);
    expect(validateToolOutput(schema, { structuredContent: {} }).status).toBe('skipped');
  });

  it('refuses more than the allowed number of allOf/anyOf/oneOf branches', () => {
    const many = Array.from({ length: 40 }, () => ({ type: 'object' }));
    for (const key of ['allOf', 'anyOf', 'oneOf']) {
      expect(checkAgainstSchema({ [key]: many }, {}).tooComplex).toBe(true);
    }
    expect(checkAgainstSchema({ anyOf: many.slice(0, 32) }, {}).tooComplex).toBe(false);
  });

  it('does not report a cycle as an error', () => {
    expect(validateAgainstSchema({ properties: { a: { $ref: '#' } } }, { a: { a: {} } })).toEqual(
      []
    );
  });
});

describe('pattern safety', () => {
  const note = 'pattern check skipped (pattern or value too long/complex)';

  it('skips catastrophic-backtracking shapes quickly with a note', () => {
    const evil = 'a'.repeat(40);
    for (const pattern of ['^(a+)+$', '^(a*)*b', '(.*a){20}x', '^(a)\\1$']) {
      const { result, ms } = timed(() =>
        checkAgainstSchema({ type: 'string', pattern }, `${evil}!`)
      );
      expect(ms).toBeLessThan(200);
      expect(result.issues).toEqual([]);
      expect(result.notes).toEqual([note]);
    }
  });

  it('skips over-long patterns and over-long values, noting once', () => {
    expect(checkAgainstSchema({ pattern: `^${'a'.repeat(300)}$` }, 'b').notes).toEqual([note]);
    const r = checkAgainstSchema(
      { properties: { x: { pattern: '^a$' }, y: { pattern: '^a$' } } },
      { x: 'b'.repeat(5000), y: 'b'.repeat(5000) }
    );
    expect(r.issues).toEqual([]);
    expect(r.notes).toEqual([note]);
  });

  it('still enforces ordinary patterns, and reuses the compiled regex', () => {
    const r = checkAgainstSchema({ items: { pattern: '^a' } }, ['ab', 'ba', 'ac', 'ca']);
    expect(r.issues.map((i) => i.path)).toEqual(['$[1]', '$[3]']);
    expect(r.notes).toEqual([]);
  });

  it('surfaces notes on a valid/invalid tool output result', () => {
    const schema = { pattern: '^(a+)+$' };
    expect(validateToolOutput({ ...schema, type: 'string' }, { structuredContent: 'x' })).toEqual({
      status: 'valid',
      notes: [note],
    });
    const res = validateToolOutput(
      { type: 'object', properties: { s: schema }, required: ['k'] },
      { structuredContent: { s: 'x' } }
    );
    expect(res.status).toBe('invalid');
    expect(res.status === 'invalid' && res.notes).toEqual([note]);
  });
});
