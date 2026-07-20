import { describe, expect, it } from 'vitest';
import { evaluateOwsCondition, readOwsPath, resolveOwsValue } from '../runtime-expression';

describe('OWS runtime expressions', () => {
  const context = {
    input: { active: true, count: 3, name: 'Ada' },
    result: { ids: ['a', 'b'] },
  };

  it('evaluates bounded boolean comparisons without script execution', () => {
    expect(evaluateOwsCondition('${.input.active} && ${.input.count} >= 3', context)).toBe(true);
    expect(evaluateOwsCondition('${.input.name} == "Grace" || ${.input.count} < 1', context)).toBe(
      false
    );
  });

  it('resolves exact values and template tokens from context paths', () => {
    expect(resolveOwsValue('${.result.ids}', context)).toEqual(['a', 'b']);
    expect(resolveOwsValue('Hello ${.input.name}!', context)).toBe('Hello Ada!');
  });

  it('rejects unsupported code syntax', () => {
    expect(() => evaluateOwsCondition('process.exit(1)', context)).toThrow('unsupported token');
  });

  it('does not traverse inherited context properties', () => {
    const inherited = Object.create({ secret: 'nope' }) as Record<string, unknown>;
    inherited.visible = 'yes';
    expect(resolveOwsValue('${.secret}', inherited)).toBeUndefined();
    expect(resolveOwsValue('${.visible}', inherited)).toBe('yes');
  });

  it('supports JSON literals, unary expressions, every comparison, and nested parentheses', () => {
    expect(
      evaluateOwsCondition('!false && (3 > 2) && (3 >= 3) && (2 < 3) && (2 <= 2)', context)
    ).toBe(true);
    expect(evaluateOwsCondition('3 != 4 && 3 == 3 && null == null', context)).toBe(true);
    expect(evaluateOwsCondition('"Ada" > "Grace"', context)).toBe(false);
  });

  it('resolves arrays and records recursively while substituting absent values as empty strings', () => {
    expect(resolveOwsValue(['${.input.count}', 'missing=${.missing}'], context)).toEqual([
      3,
      'missing=',
    ]);
    expect(
      resolveOwsValue({ user: '${.input.name}', active: '${.input.active}' }, context)
    ).toEqual({
      user: 'Ada',
      active: true,
    });
    expect(readOwsPath(context, '${.input.name} trailing')).toBeUndefined();
  });

  it.each([
    '',
    'true trailing',
    '(',
    'true &&',
    '${.input.name} + 1',
  ])('rejects incomplete or unsupported expression %j', (source) => {
    expect(() => evaluateOwsCondition(source, context)).toThrow(/OWS condition/);
  });
});
