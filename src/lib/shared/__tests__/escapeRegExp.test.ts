import { describe, expect, it } from 'vitest';
import { escapeRegExp } from '../escapeRegExp';

describe('escapeRegExp', () => {
  it('escapes every regex metacharacter', () => {
    expect(escapeRegExp('a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o')).toBe(
      'a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o'
    );
  });

  it('leaves ordinary characters untouched', () => {
    expect(escapeRegExp('user_id-123')).toBe('user_id-123');
  });

  it('makes a metacharacter key safe to embed in a {{key}} pattern', () => {
    const key = 'price($)';
    // Without escaping this throws SyntaxError; with it the literal key matches.
    const re = new RegExp(`{{${escapeRegExp(key)}}}`, 'g');
    expect('total {{price($)}} usd'.replace(re, () => '9')).toBe('total 9 usd');
  });
});
