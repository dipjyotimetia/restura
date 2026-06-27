import { describe, it, expect } from 'vitest';
import { findVariableTokens, hasVariableToken } from '../variableTokens';

describe('findVariableTokens', () => {
  it('returns no tokens for plain text', () => {
    expect(findVariableTokens('https://example.com/users')).toEqual([]);
  });

  it('locates a single token with correct offsets and name', () => {
    const tokens = findVariableTokens('{{baseUrl}}/json');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({ start: 0, end: 11, name: 'baseUrl' });
  });

  it('locates multiple tokens in order with literals between', () => {
    const text = 'pre-{{a}}-{{b}}-post';
    const tokens = findVariableTokens(text);
    expect(tokens.map((t) => t.name)).toEqual(['a', 'b']);
    // Offsets must slice back to the exact token text.
    for (const t of tokens) {
      expect(text.slice(t.start, t.end)).toBe(`{{${t.name}}}`);
    }
  });

  it('trims whitespace and supports dynamic `$` names', () => {
    const tokens = findVariableTokens('{{ $randomUUID }}');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.name).toBe('$randomUUID');
    // The reported span still covers the braces and inner spaces.
    expect(tokens[0]).toMatchObject({ start: 0, end: 17 });
  });

  it('accepts dots and dashes in names', () => {
    expect(findVariableTokens('{{user.id}}-{{x-y}}').map((t) => t.name)).toEqual([
      'user.id',
      'x-y',
    ]);
  });

  it('ignores partial / empty braces', () => {
    expect(findVariableTokens('a{{b')).toEqual([]);
    expect(findVariableTokens('{{ }}')).toEqual([]);
  });
});

describe('hasVariableToken', () => {
  it('is true only for a complete token', () => {
    expect(hasVariableToken('{{baseUrl}}/x')).toBe(true);
    expect(hasVariableToken('{{ $randomUUID }}')).toBe(true);
    expect(hasVariableToken('no vars here')).toBe(false);
    expect(hasVariableToken('half {{')).toBe(false);
    expect(hasVariableToken('{{ }}')).toBe(false);
  });

  it('does not carry regex state across calls', () => {
    // A shared /g regex would alternate true/false via lastIndex; guard that.
    for (let i = 0; i < 4; i++) expect(hasVariableToken('{{x}}')).toBe(true);
  });
});
