import { describe, expect, it } from 'vitest';
import type { KeyValue } from '@/types';
import { applyUrlInput, buildDisplayUrl, looksLikeCurl, parseQuery, splitUrl } from './urlQuery';

const row = (key: string, value: string, extra: Partial<KeyValue> = {}): KeyValue => ({
  id: `id-${key}`,
  key,
  value,
  enabled: true,
  ...extra,
});

let n = 0;
const makeId = () => `new-${++n}`;

describe('splitUrl', () => {
  it('separates base, query and fragment', () => {
    expect(splitUrl('https://x.dev/p?a=1&b=2#top')).toEqual({
      base: 'https://x.dev/p',
      query: 'a=1&b=2',
      hash: '#top',
    });
    expect(splitUrl('https://x.dev/p#a?b')).toEqual({
      base: 'https://x.dev/p',
      query: '',
      hash: '#a?b',
    });
  });
});

describe('parseQuery', () => {
  it('decodes escapes, keeps malformed ones and "+" verbatim, allows empty values', () => {
    expect(parseQuery('q=a%20b&pct=100%&plus=a+b&flag&&x=')).toEqual([
      { key: 'q', value: 'a b' },
      { key: 'pct', value: '100%' },
      { key: 'plus', value: 'a+b' },
      { key: 'flag', value: '' },
      { key: 'x', value: '' },
    ]);
  });
});

describe('buildDisplayUrl', () => {
  it('appends enabled, keyed params and skips disabled or empty-key rows', () => {
    const params = [
      row('a', '1'),
      row('off', 'x', { enabled: false }),
      row('', 'orphan'),
      row('flag', ''),
    ];
    expect(buildDisplayUrl('https://x.dev/p#h', params)).toBe('https://x.dev/p?a=1&flag#h');
  });

  it('keeps a legacy query already stored in the URL', () => {
    expect(buildDisplayUrl('https://x.dev/?legacy=1', [row('a', '1')])).toBe(
      'https://x.dev/?legacy=1&a=1'
    );
  });

  it('escapes only characters that would change the re-parse and keeps {{vars}}', () => {
    const params = [row('k=1', 'a&b#c'), row('lit', 'a%20b'), row('v', '{{token}}')];
    expect(buildDisplayUrl('https://x.dev', params)).toBe(
      'https://x.dev?k%3D1=a%26b%23c&lit=a%2520b&v={{token}}'
    );
  });
});

describe('applyUrlInput', () => {
  it('moves the query into params and strips it from the stored URL', () => {
    const out = applyUrlInput('https://x.dev/p?a=1&b=two#h', [], makeId);
    expect(out.url).toBe('https://x.dev/p#h');
    expect(out.params.map((p) => [p.key, p.value, p.enabled])).toEqual([
      ['a', '1', true],
      ['b', 'two', true],
    ]);
  });

  it('keeps ids, descriptions and positions of matched rows and preserves disabled rows', () => {
    const params = [
      row('a', '1', { description: 'first' }),
      row('off', 'x', { enabled: false }),
      row('b', '2'),
    ];
    const out = applyUrlInput('https://x.dev?a=9&b=2&c=3', params, makeId);
    expect(out.params[0]).toEqual({ ...params[0], value: '9' });
    expect(out.params[1]).toBe(params[1]);
    expect(out.params[2]).toBe(params[2]);
    expect(out.params[3]).toMatchObject({ key: 'c', value: '3', enabled: true });
  });

  it('removes enabled rows the user deleted from the URL', () => {
    const out = applyUrlInput('https://x.dev', [row('a', '1'), row('b', '2')], makeId);
    expect(out.params).toEqual([]);
  });

  it('matches duplicate keys in order', () => {
    const params = [row('tag', 'x', { id: 't1' }), row('tag', 'y', { id: 't2' })];
    const out = applyUrlInput('https://x.dev?tag=x&tag=z', params, makeId);
    expect(out.params.map((p) => [p.id, p.value])).toEqual([
      ['t1', 'x'],
      ['t2', 'z'],
    ]);
  });

  it('round-trips display text without changing the request', () => {
    const params = [row('q', 'a b&c'), row('lit', '50%'), row('v', '{{x}}'), row('flag', '')];
    const display = buildDisplayUrl('https://x.dev/p', params);
    const out = applyUrlInput(display, params, makeId);
    expect(out.url).toBe('https://x.dev/p');
    expect(out.params).toEqual(params);
  });
});

describe('looksLikeCurl', () => {
  it('detects curl commands only', () => {
    expect(looksLikeCurl("  curl -X POST 'https://x.dev'")).toBe(true);
    expect(looksLikeCurl('curl.exe https://x.dev')).toBe(true);
    expect(looksLikeCurl('https://x.dev/curl ')).toBe(false);
    expect(looksLikeCurl('curly')).toBe(false);
  });
});
