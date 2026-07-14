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
});
