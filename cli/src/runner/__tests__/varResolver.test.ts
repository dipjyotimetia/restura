import { describe, expect, it } from 'vitest';
import { resolveVarsDeep } from '../varResolver';

describe('resolveVarsDeep', () => {
  it('replaces user vars', () => {
    expect(resolveVarsDeep('Hello {{NAME}}', { NAME: 'world' })).toBe('Hello world');
  });

  it('leaves unknown user vars as-is', () => {
    expect(resolveVarsDeep('Hello {{NAME}}', {})).toBe('Hello {{NAME}}');
  });

  it('expands dynamic helpers (built-in)', () => {
    const out = resolveVarsDeep('id={{$randomUUID}}', {});
    expect(out).toMatch(/^id=[0-9a-f-]{36}$/);
  });

  it('runs user vars before dynamic helpers (no double-substitution issues)', () => {
    expect(resolveVarsDeep('{{GREETING}} {{$randomInt}}', { GREETING: 'Hi' })).toMatch(/^Hi \d+$/);
  });

  it('fails clearly for unavailable private values and SecretRef handles', () => {
    expect(() => resolveVarsDeep('{{TOKEN}}', {}, new Set(['TOKEN']))).toThrow(
      'Private variable "TOKEN" is unavailable in the CLI'
    );
    expect(() => resolveVarsDeep('{{handle:desktop-token}}', {})).toThrow(
      'SecretRef handles are unavailable in the CLI'
    );
  });
});
