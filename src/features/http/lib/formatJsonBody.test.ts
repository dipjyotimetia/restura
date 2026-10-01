import { describe, expect, it } from 'vitest';
import { formatJsonBody } from './formatJsonBody';

describe('formatJsonBody', () => {
  it('pretty-prints plain JSON', () => {
    expect(formatJsonBody('{"a":1,"b":[1,2]}')).toBe(
      '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}'
    );
  });

  it('keeps bare and quoted {{vars}} exactly as written', () => {
    expect(formatJsonBody('{"id":{{id}},"name":"{{first}} {{last}}","n":{{ count }}}')).toBe(
      '{\n  "id": {{id}},\n  "name": "{{first}} {{last}}",\n  "n": {{ count }}\n}'
    );
  });

  it('handles escaped quotes before a token and a whole-string token', () => {
    expect(formatJsonBody('{"q":"say \\"hi\\" {{who}}","t":"{{tok}}"}')).toBe(
      '{\n  "q": "say \\"hi\\" {{who}}",\n  "t": "{{tok}}"\n}'
    );
  });

  it('returns null for empty or invalid bodies', () => {
    expect(formatJsonBody('   ')).toBeNull();
    expect(formatJsonBody('{"a":')).toBeNull();
    expect(formatJsonBody('{"a": {{x}')).toBeNull();
    expect(formatJsonBody('{"a": {{x}} oops}')).toBeNull();
  });
});
