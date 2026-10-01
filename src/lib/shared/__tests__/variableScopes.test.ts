import { describe, expect, it } from 'vitest';
import type { KeyValue } from '@/types/common';
import {
  buildKnownNames,
  buildScopedVariableResolution,
  buildValueMap,
  describeVariables,
  variableSourceLabel,
} from '../variableScopes';

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

  it('applies the canonical base, sub-environment, collection and folder ordering', () => {
    expect(
      buildValueMap({
        globals: { shared: 'global' },
        baseEnvironment: [kv('shared', 'base')],
        subEnvironment: [kv('shared', 'sub')],
        collection: [kv('shared', 'collection')],
        folders: [[kv('shared', 'outer')], [kv('shared', 'inner')]],
        dataRow: { shared: 'row' },
      })
    ).toEqual({ shared: 'row' });
  });
});

describe('buildScopedVariableResolution', () => {
  it('reports the winning value and provenance without exposing a losing secret', () => {
    const result = buildScopedVariableResolution({
      globals: { host: 'https://global.example' },
      baseEnvironment: [kv('host', 'https://base.example'), kv('token', 'base-secret')],
      subEnvironment: [kv('host', 'https://sub.example')],
      collection: [kv('host', 'https://collection.example')],
      folders: [[kv('host', 'https://folder.example')]],
    });

    expect(result.values).toEqual({ host: 'https://folder.example', token: 'base-secret' });
    expect(result.provenance).toEqual({ host: 'folder', token: 'base-environment' });
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

describe('describeVariables', () => {
  const kv = (key: string, value: string, extra: Record<string, unknown> = {}): KeyValue =>
    ({ id: key, key, value, enabled: true, ...extra }) as KeyValue;

  it('reports the winning value and scope, sorted by name', () => {
    const details = describeVariables({
      globals: { host: 'global.dev', only: 'g' },
      baseEnvironment: [kv('host', 'env.dev'), kv('off', 'x', { enabled: false })],
      collection: [kv('host', 'col.dev')],
    });
    expect(details).toEqual([
      { name: 'host', value: 'col.dev', source: 'collection', secret: false },
      { name: 'only', value: 'g', source: 'global', secret: false },
    ]);
  });

  it('flags secrets from the winning scope and omits values held only as handles', () => {
    const details = describeVariables({
      globals: { token: 'plain' },
      baseEnvironment: [
        kv('token', 'shh', { secret: true }),
        kv('apiKey', '', { secretRef: { kind: 'handle', id: 'h1' } }),
      ],
      collection: [kv('apiKey', 'override')],
    });
    expect(details).toEqual([
      { name: 'apiKey', value: 'override', source: 'collection', secret: false },
      { name: 'token', value: 'shh', source: 'base-environment', secret: true },
    ]);
    const handleOnly = describeVariables({
      baseEnvironment: [kv('apiKey', '', { secretRef: { kind: 'handle', id: 'h1' } })],
    });
    expect(handleOnly).toEqual([{ name: 'apiKey', source: 'base-environment', secret: true }]);
  });

  it('lists script-set keys without a value and labels every source', () => {
    const details = describeVariables({ scriptSetKeys: ['fromScript'], dataRow: { row: '1' } });
    expect(details).toEqual([
      { name: 'fromScript', source: 'script', secret: false },
      { name: 'row', value: '1', source: 'data-row', secret: false },
    ]);
    expect(variableSourceLabel('script')).toBe('Pre-request script');
    expect(variableSourceLabel('sub-environment')).toBe('Sub-environment');
  });
});
