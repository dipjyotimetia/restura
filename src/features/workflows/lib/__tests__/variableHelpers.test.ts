import { describe, it, expect } from 'vitest';
import { injectString } from '../variableHelpers';

describe('injectString', () => {
  it('substitutes a simple variable', () => {
    expect(injectString('{{host}}/path', { host: 'example.com' })).toBe('example.com/path');
  });

  it('substitutes every occurrence', () => {
    expect(injectString('{{x}}-{{x}}', { x: 'a' })).toBe('a-a');
  });

  it('preserves $ metacharacters in the value (no String.replace pattern expansion)', () => {
    // Values containing $&, $1, $$, $` are regression-prone when passed as the
    // replacement string to String.replace. They must be inserted verbatim.
    expect(injectString('{{pw}}', { pw: 'pa$$word' })).toBe('pa$$word');
    expect(injectString('{{v}}', { v: '$&literal' })).toBe('$&literal');
    expect(injectString('{{v}}', { v: '$1$2' })).toBe('$1$2');
    expect(injectString('{{v}}', { v: 'a$`b' })).toBe('a$`b');
  });

  it('escapes regex metacharacters in keys', () => {
    expect(injectString('{{a.b}}', { 'a.b': 'ok' })).toBe('ok');
  });

  it('leaves unresolved placeholders intact', () => {
    expect(injectString('{{missing}}', { other: 'x' })).toBe('{{missing}}');
  });

  it('returns empty/falsy input unchanged', () => {
    expect(injectString('', { a: 'b' })).toBe('');
  });
});
