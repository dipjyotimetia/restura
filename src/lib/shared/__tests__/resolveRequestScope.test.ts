import { describe, expect, it, vi } from 'vitest';
import { resolveMapText, resolveRequestScopeText } from '../resolveRequestScope';

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

describe('resolveMapText', () => {
  const walk = (text: string, map: Record<string, string>) => {
    let out = text;
    for (const [key, value] of Object.entries(map)) out = out.split(`{{${key}}}`).join(value);
    return out;
  };

  it.each([
    ['a token inside a value that an earlier key names', '{{a}}', { b: '1', a: '{{b}}' }],
    ['a literal token inside a value', 'x{{c}}', { c: '{{b}}', b: '1' }],
    ['an earlier key referencing a later one', '{{a}}', { a: '{{b}}', b: '1' }],
  ])('a secret name elsewhere does not change %s', (_name, text, values) => {
    const plain = walk(text, values);
    expect(resolveMapText(text, { ...values, sec: 'S' }, ['sec'], walk)).toBe(plain);
  });

  it('still lets the walk run what it adds beyond the map', () => {
    const dynamic = (text: string, map: Record<string, string>) =>
      walk(text, map).replace('{{$now}}', 'NOW');
    expect(resolveMapText('{{$now}}', { sec: 'S' }, ['sec'], dynamic)).toBe('NOW');
  });
});
