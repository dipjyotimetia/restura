import { describe, expect, it } from 'vitest';
import { escapeJson, rubyString } from './types';

describe('escapeJson', () => {
  it('escapes backslashes, quotes, control characters and line separators', () => {
    expect(escapeJson('a\\b"c\r\n ')).toBe('a\\\\b\\"c\\r\\n\\u2028');
  });
});

describe('rubyString', () => {
  it('escapes # so #{...} never interpolates', () => {
    expect(rubyString('#{x}')).toBe('"\\#{x}"');
  });

  it('keeps an input backslash before # as a literal backslash and a literal #', () => {
    // Ruby reads "\\\#" as backslash + "#".
    expect(rubyString('\\#')).toBe('"\\\\\\#"');
  });
});
