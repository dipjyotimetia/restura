import { describe, expect, it } from 'vitest';
import { validateJSON, validateXML } from '../validations';

describe('validateJSON', () => {
  it('returns true for valid JSON', () => {
    expect(validateJSON('{"a": 1}')).toBe(true);
    expect(validateJSON('[]')).toBe(true);
    expect(validateJSON('"string"')).toBe(true);
    expect(validateJSON('null')).toBe(true);
  });

  it('returns false for invalid JSON', () => {
    expect(validateJSON('{invalid}')).toBe(false);
    expect(validateJSON('')).toBe(false);
    expect(validateJSON('undefined')).toBe(false);
  });
});

describe('validateXML', () => {
  it('returns true for valid XML', () => {
    expect(validateXML('<root><child/></root>')).toBe(true);
    expect(validateXML('<root attr="value">text</root>')).toBe(true);
  });

  it('returns false for invalid XML', () => {
    expect(validateXML('<unclosed')).toBe(false);
    expect(validateXML('<a><b></a>')).toBe(false);
  });
});
