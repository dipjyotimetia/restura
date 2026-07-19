import { describe, expect, it } from 'vitest';
import { parseMcpArgument } from '../mcpArgumentValidation';

describe('parseMcpArgument', () => {
  it('rejects malformed JSON for object arguments', () => {
    expect(parseMcpArgument('{', 'object')).toEqual({
      ok: false,
      error: 'Enter valid JSON for this object.',
    });
  });

  it('rejects non-numeric input for numeric arguments', () => {
    expect(parseMcpArgument('one', 'number')).toEqual({
      ok: false,
      error: 'Enter a valid number.',
    });
    expect(parseMcpArgument('   ', 'number')).toEqual({
      ok: false,
      error: 'Enter a valid number.',
    });
    expect(parseMcpArgument('1.5', 'integer')).toEqual({
      ok: false,
      error: 'Enter a valid integer.',
    });
  });

  it('returns typed values for valid scalar inputs', () => {
    expect(parseMcpArgument('42', 'integer')).toEqual({ ok: true, value: 42 });
    expect(parseMcpArgument('1.5', 'number')).toEqual({ ok: true, value: 1.5 });
    expect(parseMcpArgument('true', 'boolean')).toEqual({ ok: true, value: true });
    expect(parseMcpArgument('false', 'boolean')).toEqual({ ok: true, value: false });
    expect(parseMcpArgument('restura', 'string')).toEqual({ ok: true, value: 'restura' });
  });

  it('validates boolean and structured argument types', () => {
    expect(parseMcpArgument('yes', 'boolean')).toEqual({
      ok: false,
      error: 'Enter true or false.',
    });
    expect(parseMcpArgument('{"name":"restura"}', 'object')).toEqual({
      ok: true,
      value: { name: 'restura' },
    });
    expect(parseMcpArgument('[]', 'object')).toEqual({
      ok: false,
      error: 'Enter valid JSON for this object.',
    });
    expect(parseMcpArgument('["a"]', 'array')).toEqual({ ok: true, value: ['a'] });
    expect(parseMcpArgument('{}', 'array')).toEqual({
      ok: false,
      error: 'Enter valid JSON for this array.',
    });
    expect(parseMcpArgument('{', 'array')).toEqual({
      ok: false,
      error: 'Enter valid JSON for this array.',
    });
  });
});
