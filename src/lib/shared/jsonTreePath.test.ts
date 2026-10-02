import { JSONPath } from 'jsonpath-plus';
import { describe, expect, it } from 'vitest';
import { jsonPathFor, previewJson } from './jsonTreePath';

const doc = {
  user: { name: 'Ada', tags: ['x', 'y'] },
  'content-type': 'json',
  "it's": { 'a\\b': 1 },
  $weird: true,
  '0': 'zero-key',
};

const evaluate = (path: string) => JSONPath({ path, json: doc, wrap: true }) as unknown[];

describe('jsonPathFor', () => {
  it('builds dot and bracket paths', () => {
    expect(jsonPathFor([])).toBe('$');
    expect(jsonPathFor(['user', 'tags', 1])).toBe('$.user.tags[1]');
    expect(jsonPathFor(['content-type'])).toBe("$['content-type']");
  });

  it.each([
    [['user', 'name'], 'Ada'],
    [['user', 'tags', 1], 'y'],
    [['content-type'], 'json'],
    [["it's", 'a\\b'], 1],
    [['$weird'], true],
    [['0'], 'zero-key'],
  ] as const)('copied path %j finds its node with the JSONPath box', (segments, expected) => {
    expect(evaluate(jsonPathFor(segments))).toEqual([expected]);
  });
});

describe('previewJson', () => {
  it('summarises containers and quotes strings', () => {
    expect(previewJson([1, 2, 3])).toBe('Array(3)');
    expect(previewJson({ a: 1, b: 2 })).toBe('{a, b}');
    expect(previewJson({ a: 1, b: 2, c: 3, d: 4 })).toBe('{a, b, c, …}');
    expect(previewJson('hi')).toBe('"hi"');
    expect(previewJson(null)).toBe('null');
    expect(previewJson(4)).toBe('4');
  });
});
