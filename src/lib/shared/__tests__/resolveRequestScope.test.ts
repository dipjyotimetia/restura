import { describe, expect, it, vi } from 'vitest';
import { resolveRequestScopeText } from '../resolveRequestScope';

describe('resolveRequestScopeText', () => {
  it('walks request-scope values in insertion order before the store', () => {
    const resolveVariables = vi.fn((text: string) => text.replace('{{b}}', 'store'));
    expect(
      resolveRequestScopeText('{{ a }}', { values: { a: '{{b}}', b: 'scope' }, resolveVariables })
    ).toBe('scope');
    expect(
      resolveRequestScopeText('{{ a }}', { values: { b: 'scope', a: '{{b}}' }, resolveVariables })
    ).toBe('store');
  });

  it('keeps a secret-variable token from the store, written as it was', () => {
    const resolveVariables = vi.fn((text: string) =>
      text.replace(/\{\{\s*sec\s*\}\}/g, 'consumed')
    );
    const out = resolveRequestScopeText('{{ sec }}-{{sec}}-{{constructor}}', {
      values: {},
      secretVariables: { sec: { kind: 'handle', id: 'h' } },
      resolveVariables,
    });
    expect(out).toBe('{{ sec }}-{{sec}}-{{constructor}}');
  });

  it('reads the values map at call time', () => {
    const values: Record<string, string> = {};
    const scope = { values, resolveVariables: (text: string) => text };
    expect(resolveRequestScopeText('{{a}}', scope)).toBe('{{a}}');
    values['a'] = 'v';
    expect(resolveRequestScopeText('{{a}}', scope)).toBe('v');
  });
});
