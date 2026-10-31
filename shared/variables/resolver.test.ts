import { describe, expect, it } from 'vitest';
import {
  createVariableScope,
  expandChainedVariables,
  lookupVariable,
  MAX_CHAIN_DEPTH,
  resolveChainedVariableText,
  resolveVariableText,
  substituteVariables,
} from './resolver';
import { hasVariableToken, replaceVariableTokens, scanVariableTokens } from './tokens';

describe('variable token grammar', () => {
  const ACCEPTED: ReadonlyArray<[text: string, name: string]> = [
    ['{{baseUrl}}', 'baseUrl'],
    ['{{ baseUrl }}', 'baseUrl'],
    ['{{\t\n baseUrl \n}}', 'baseUrl'],
    ['{{my key}}', 'my key'],
    ['{{ my key }}', 'my key'],
    ['{{a:b}}', 'a:b'],
    ['{{a/b}}', 'a/b'],
    ['{{user.id}}', 'user.id'],
    ['{{x-y}}', 'x-y'],
    ['{{handle:x}}', 'handle:x'],
    ['{{$randomUUID}}', '$randomUUID'],
    ['{{ $randomUUID }}', '$randomUUID'],
    ['{{a"b}}', 'a"b'],
  ];
  for (const [text, name] of ACCEPTED) {
    it(`accepts ${JSON.stringify(text)}`, () => {
      expect(scanVariableTokens(text)).toEqual([{ start: 0, end: text.length, name }]);
      expect(hasVariableToken(text)).toBe(true);
    });
  }

  const REJECTED = [
    '',
    'plain',
    'a{{b',
    'b}}',
    '{{}}',
    '{{ }}',
    '{{\n\t}}',
    '{a}',
    '{{a}',
    '{{a{b}}',
  ];
  for (const text of REJECTED) {
    it(`rejects ${JSON.stringify(text)}`, () => {
      expect(scanVariableTokens(text)).toEqual([]);
      expect(hasVariableToken(text)).toBe(false);
    });
  }

  it('takes the innermost pair for nested braces', () => {
    expect(scanVariableTokens('{{a{{b}}')).toEqual([{ start: 3, end: 8, name: 'b' }]);
    expect(scanVariableTokens('{{{a}}}')).toEqual([{ start: 1, end: 6, name: 'a' }]);
  });

  it('finds a token after a blank one', () => {
    expect(hasVariableToken('{{ }} {{a}}')).toBe(true);
    expect(scanVariableTokens('{{ }} {{a}}').map((token) => token.name)).toEqual(['a']);
  });

  it('reports offsets that slice back to the token text, in order', () => {
    const text = 'pre-{{a}}-{{ b }}-post';
    const tokens = scanVariableTokens(text);
    expect(tokens.map((t) => t.name)).toEqual(['a', 'b']);
    expect(tokens.map((t) => text.slice(t.start, t.end))).toEqual(['{{a}}', '{{ b }}']);
  });

  it('carries no regex state across calls', () => {
    for (let i = 0; i < 4; i++) {
      expect(hasVariableToken('{{x}}')).toBe(true);
      expect(scanVariableTokens('{{x}}')).toHaveLength(1);
    }
  });

  it('hands the replacer the name and the original text; a return value is literal', () => {
    expect(replaceVariableTokens('{{ a }}|{{b}}', (name, raw) => `${name}=${raw}$&`)).toBe(
      'a={{ a }}$&|b={{b}}$&'
    );
  });
});

describe('core resolver', () => {
  const TABLE: ReadonlyArray<{
    name: string;
    text: string;
    vars: Record<string, string>;
    out: string;
  }> = [
    { name: 'spaced key', text: '{{my key}}', vars: { 'my key': 'v' }, out: 'v' },
    { name: 'a:b key', text: '{{a:b}}', vars: { 'a:b': 'v' }, out: 'v' },
    { name: 'handle:x has no core policy', text: '{{handle:x}}', vars: {}, out: '{{handle:x}}' },
    { name: 'single pass', text: '{{a}}', vars: { a: '{{b}}', b: 'v' }, out: '{{b}}' },
    { name: 'cycle', text: '{{a}}', vars: { a: '{{b}}', b: '{{a}}' }, out: '{{b}}' },
    { name: 'inherited name', text: '{{constructor}}', vars: {}, out: '{{constructor}}' },
    { name: 'prototype name', text: '{{__proto__}}', vars: {}, out: '{{__proto__}}' },
    { name: '$ in a value', text: '{{a}}', vars: { a: '$&$1$$' }, out: '$&$1$$' },
    { name: 'padding', text: '{{  a  }}', vars: { a: 'v' }, out: 'v' },
    { name: 'unknown keeps its text', text: '{{  a  }}', vars: {}, out: '{{  a  }}' },
  ];
  for (const row of TABLE) {
    it(row.name, () => {
      expect(resolveVariableText(row.text, [row.vars])).toBe(row.out);
    });
  }

  it('looks up scopes in order, own properties only', () => {
    expect(lookupVariable([{ a: '1' }, { a: '2', b: '3' }], 'a')).toBe('1');
    expect(lookupVariable([{ a: '1' }, { a: '2', b: '3' }], 'b')).toBe('3');
    expect(lookupVariable([{}], 'toString')).toBeUndefined();
    expect(lookupVariable([{}], '__proto__')).toBeUndefined();
  });

  it('treats a non-string value as text and a missing one as unknown', () => {
    expect(lookupVariable([{ port: 8080 } as unknown as Record<string, string>], 'port')).toBe(
      '8080'
    );
    expect(lookupVariable([{ a: null } as unknown as Record<string, string>], 'a')).toBeUndefined();
  });

  it('leaves dynamic names to the dynamic stage, which also reaches user values', () => {
    expect(substituteVariables('{{$randomUUID}}', [{ $randomUUID: 'scope' }])).toBe(
      '{{$randomUUID}}'
    );
    expect(resolveVariableText('{{a}}', [{ a: '{{$randomUUID}}' }])).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveVariableText('{{$nopeNotReal}}', [{}])).toBe('{{$nopeNotReal}}');
  });

  it('runs the policy hook for user names with whether they resolved, and lets it refuse', () => {
    const seen: Array<[string, boolean]> = [];
    resolveVariableText('{{a}} {{b}} {{$randomUUID}}', [{ a: '1' }], {
      onToken: (name, found) => {
        seen.push([name, found]);
      },
    });
    expect(seen).toEqual([
      ['a', true],
      ['b', false],
    ]);
    expect(() =>
      resolveVariableText('{{a}}', [{}], {
        onToken: () => {
          throw new Error('refused');
        },
      })
    ).toThrow('refused');
  });
});

describe('chained expansion', () => {
  const scope = (vars: Record<string, string>) => [vars];

  it('expands chains regardless of definition order', () => {
    expect(expandChainedVariables('{{a}}', scope({ a: '{{b}}', b: '{{c}}', c: 'v' }))).toBe('v');
    expect(expandChainedVariables('{{a}}', scope({ c: 'v', b: '{{c}}', a: '{{b}}' }))).toBe('v');
  });

  it('terminates a cycle on the token that closes it, whatever its length', () => {
    expect(expandChainedVariables('{{a}}', scope({ a: '{{a}}' }))).toBe('{{a}}');
    expect(expandChainedVariables('{{a}}', scope({ a: '{{b}}', b: '{{a}}' }))).toBe('{{a}}');
    expect(expandChainedVariables('{{a}}', scope({ a: '{{b}}', b: '{{c}}', c: '{{a}}' }))).toBe(
      '{{a}}'
    );
    expect(expandChainedVariables('{{a}}', scope({ a: '{{b}}-{{b}}', b: '[{{a}}]' }))).toBe(
      '[{{a}}]-[{{a}}]'
    );
  });

  it('does not mistake a repeated sibling for a cycle', () => {
    expect(expandChainedVariables('{{a}}{{a}}', scope({ a: '{{b}}{{b}}', b: 'v' }))).toBe('vvvv');
  });

  it(`stops following a chain after ${MAX_CHAIN_DEPTH} levels and keeps the literal token`, () => {
    const vars: Record<string, string> = {};
    for (let i = 0; i < MAX_CHAIN_DEPTH; i++) vars[`v${i}`] = `{{v${i + 1}}}`;
    vars[`v${MAX_CHAIN_DEPTH}`] = 'end';
    expect(expandChainedVariables('{{v0}}', scope(vars))).toBe(`{{v${MAX_CHAIN_DEPTH}}}`);
    expect(expandChainedVariables('{{v1}}', scope(vars))).toBe('end');
  });

  it('stays bounded on a fan-out that would otherwise grow exponentially', () => {
    const vars: Record<string, string> = {};
    for (let i = 0; i < MAX_CHAIN_DEPTH; i++) {
      vars[`v${i}`] = `{{v${i + 1}}}`.repeat(50);
    }
    vars[`v${MAX_CHAIN_DEPTH}`] = 'leaf';
    const start = performance.now();
    const out = expandChainedVariables('{{v0}}', scope(vars));
    expect(performance.now() - start).toBeLessThan(5_000);
    expect(out).toContain('{{');
  });

  it('never counts a large value used directly against the chain budget', () => {
    const big = 'x'.repeat(50_000_000);
    expect(expandChainedVariables('{{big}}', scope({ big }))).toHaveLength(big.length);
  });

  it('honours scope precedence at every level', () => {
    expect(
      expandChainedVariables('{{g}}', [{ host: 'env' }, { g: '{{host}}', host: 'global' }])
    ).toBe('env');
  });

  it('does not follow a chain into an opaque name, but still resolves it directly', () => {
    const isOpaque = (name: string) => name === 'sec';
    const vars = scope({ a: '{{sec}}', sec: 'placeholder' });
    expect(expandChainedVariables('{{a}}', vars, { isOpaque })).toBe('{{sec}}');
    expect(expandChainedVariables('{{sec}}', vars, { isOpaque })).toBe('placeholder');
  });

  it('lets a scope own a $ name in chained mode, leaving other dynamics untouched', () => {
    expect(expandChainedVariables('{{$mine}} {{$randomUUID}}', scope({ $mine: 'v' }))).toBe(
      'v {{$randomUUID}}'
    );
  });

  it('expands a dynamic exactly once, after the chain', () => {
    const out = resolveChainedVariableText('{{a}}', scope({ a: '{{b}}', b: '{{$randomUUID}}' }));
    expect(out).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('createVariableScope', () => {
  it('keeps the first definition, normalises padded keys, skips empty ones', () => {
    const scope = createVariableScope([
      ['a', '1'],
      ['a', '2'],
      [' b ', '3'],
      ['', '4'],
      ['  ', '5'],
    ]);
    expect(lookupVariable([scope], 'a')).toBe('1');
    expect(lookupVariable([scope], 'b')).toBe('3');
    expect(Object.keys(scope)).toEqual(['a', 'b']);
  });

  it('treats __proto__ as plain data', () => {
    const scope = createVariableScope([['__proto__', 'v']]);
    expect(lookupVariable([scope], '__proto__')).toBe('v');
    expect(lookupVariable([scope], 'constructor')).toBeUndefined();
  });
});
