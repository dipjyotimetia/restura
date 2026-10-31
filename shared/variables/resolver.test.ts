import { describe, expect, it } from 'vitest';
import {
  expandVariablesInOrder,
  lookupVariable,
  resolveVariableText,
  substituteVariables,
} from './resolver';
import {
  hasVariableToken,
  isPlainVariableName,
  replaceVariableTokens,
  scanVariableTokens,
} from './tokens';

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
    '{{a\nb}}',
    '{{a\r\nb}}',
    '{{\n  "a": 1,\n  "b": 2\n}}',
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

describe('isPlainVariableName', () => {
  for (const name of ['a', 'baseUrl', 'user.id', 'x-y', 'a_1', '$randomUUID', '$not.a-helper']) {
    it(`accepts ${JSON.stringify(name)}`, () => {
      expect(isPlainVariableName(name)).toBe(true);
    });
  }
  for (const name of ['#if a', '/if', 'u | upper', '"k":1', 'my key', 'a:b', '$a b', '', '$']) {
    it(`rejects ${JSON.stringify(name)}`, () => {
      expect(isPlainVariableName(name)).toBe(false);
    });
  }
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

describe('in-order expansion', () => {
  const walk = (text: string, vars: Record<string, string>) =>
    expandVariablesInOrder(text, Object.entries(vars));

  it('follows a value forward, never back', () => {
    expect(walk('{{a}}', { a: '{{b}}', b: '{{c}}', c: 'v' })).toBe('v');
    expect(walk('{{a}}', { c: 'v', b: '{{c}}', a: '{{b}}' })).toBe('{{b}}');
    expect(walk('{{next}}', { apiKey: 'k', next: '{{apiKey}}' })).toBe('{{apiKey}}');
  });

  it('ends a cycle when the walk ends', () => {
    expect(walk('{{a}}', { a: '{{a}}' })).toBe('{{a}}');
    expect(walk('{{a}}', { a: '{{b}}', b: '{{a}}' })).toBe('{{a}}');
    expect(walk('{{a}}', { a: '{{b}}', b: '{{c}}', c: '{{a}}' })).toBe('{{a}}');
  });

  it('matches padded tokens and spaced names, keeping unknown text as written', () => {
    expect(walk('{{ a }} {{my key}} {{  nope }}', { a: '1', 'my key': '2' })).toBe(
      '1 2 {{  nope }}'
    );
    expect(walk('{{k}}', { ' k ': 'v' })).toBe('v');
  });

  it('takes values literally and treats inherited and blank names as nothing', () => {
    expect(walk('{{a}}', { a: '$&$1$$' })).toBe('$&$1$$');
    expect(walk('{{constructor}} {{__proto__}} {{toString}}', {})).toBe(
      '{{constructor}} {{__proto__}} {{toString}}'
    );
    expect(walk('{{__proto__}}', JSON.parse('{"__proto__":"v"}'))).toBe('v');
    expect(walk('{{ }}', { '': 'v', '  ': 'w' })).toBe('{{ }}');
  });

  it('honours every row of a repeated key in turn', () => {
    expect(
      expandVariablesInOrder('{{a}}', [
        ['a', '{{a}}!'],
        ['a', 'v'],
      ])
    ).toBe('v!');
  });

  it('leaves dynamics alone and treats non-string values as text', () => {
    expect(walk('{{$randomUUID}}', {})).toBe('{{$randomUUID}}');
    expect(walk('{{$mine}}', { $mine: 'v' })).toBe('v');
    expect(walk('{{port}}', { port: 8080 } as unknown as Record<string, string>)).toBe('8080');
    expect(walk('{{a}}', { a: null } as unknown as Record<string, string>)).toBe('{{a}}');
  });

  it('skips the scan when there is no token, and passes a large value through', () => {
    const text = 'x'.repeat(1_000_000);
    expect(walk(text, { a: 'v' })).toBe(text);
    const big = 'x'.repeat(50_000_000);
    expect(walk('{{big}}', { big })).toHaveLength(big.length);
  });

  it('fails a fan-out across many variables at the string length limit, in bounded time', () => {
    const vars: Record<string, string> = {};
    for (let i = 0; i < 10; i++) vars[`v${i}`] = `{{v${i + 1}}}`.repeat(50);
    vars['v10'] = 'leaf';
    const start = performance.now();
    expect(() => walk('{{v0}}', vars)).toThrow(RangeError);
    expect(performance.now() - start).toBeLessThan(30_000);
  }, 60_000);
});
