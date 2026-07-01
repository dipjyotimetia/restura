import { describe, expect, it } from 'vitest';
import type { KeyValue } from '@/types/common';
import { buildKnownNames, buildValueMap } from '../variableScopes';

const kv = (key: string, value: string, enabled = true): KeyValue => ({
  id: key,
  key,
  value,
  enabled,
});

describe('buildValueMap', () => {
  it('merges scopes with precedence globals < env < collection < dataRow', () => {
    const map = buildValueMap({
      globals: { a: 'g', shared: 'g' },
      env: [kv('b', 'e'), kv('shared', 'e')],
      collection: [kv('c', 'c'), kv('shared', 'c')],
      dataRow: { d: 'd', shared: 'row' },
    });
    expect(map).toEqual({ a: 'g', b: 'e', c: 'c', d: 'd', shared: 'row' });
  });

  it('env overrides globals; collection overrides env', () => {
    expect(buildValueMap({ globals: { x: 'g' }, env: [kv('x', 'e')] }).x).toBe('e');
    expect(buildValueMap({ env: [kv('x', 'e')], collection: [kv('x', 'c')] }).x).toBe('c');
  });

  it('skips disabled and empty-key entries', () => {
    const map = buildValueMap({
      env: [kv('on', '1'), kv('off', '2', false), kv('', '3')],
    });
    expect(map).toEqual({ on: '1' });
  });

  it('never includes script-set keys (no static value)', () => {
    const map = buildValueMap({ env: [kv('a', '1')], scriptSetKeys: ['token'] });
    expect(map).toEqual({ a: '1' });
    expect('token' in map).toBe(false);
  });

  it('returns an empty object for empty inputs', () => {
    expect(buildValueMap({})).toEqual({});
  });
});

describe('buildKnownNames', () => {
  it('unions enabled env/collection keys, globals, dataRow, and script-set keys', () => {
    const names = buildKnownNames({
      env: [kv('e1', 'x'), kv('eOff', 'x', false)],
      collection: [kv('c1', 'x')],
      globals: { g1: 'x' },
      dataRow: { d1: 'x' },
      scriptSetKeys: ['s1'],
    });
    expect([...names].sort()).toEqual(['c1', 'd1', 'e1', 'g1', 's1']);
    expect(names.has('eOff')).toBe(false);
  });

  it('is empty for empty inputs', () => {
    expect(buildKnownNames({}).size).toBe(0);
  });
});
