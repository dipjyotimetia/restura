import { describe, expect, it } from 'vitest';
import { applyStructuredChoices, createStructuredMerge } from './git-merge';

describe('createStructuredMerge', () => {
  it('automatically combines independent mapping changes', () => {
    const merge = createStructuredMerge(
      { http: { method: 'GET', url: '/users' }, info: { name: 'Users' } },
      { http: { method: 'POST', url: '/users' }, info: { name: 'Users' } },
      { http: { method: 'GET', url: '/v2/users' }, info: { name: 'Users' } }
    );

    expect(merge.conflicts).toEqual([]);
    expect(merge.result).toEqual({
      http: { method: 'POST', url: '/v2/users' },
      info: { name: 'Users' },
    });
  });

  it('treats arrays as atomic conflicts and escapes JSON Pointer paths', () => {
    const merge = createStructuredMerge(
      { 'a/b': { '~headers': [{ name: 'accept', value: 'json' }] } },
      { 'a/b': { '~headers': [{ name: 'accept', value: 'yaml' }] } },
      { 'a/b': { '~headers': [{ name: 'accept', value: 'xml' }] } }
    );

    expect(merge.conflicts).toEqual([
      {
        path: '/a~1b/~0headers',
        base: { present: true, value: [{ name: 'accept', value: 'json' }] },
        local: { present: true, value: [{ name: 'accept', value: 'yaml' }] },
        incoming: { present: true, value: [{ name: 'accept', value: 'xml' }] },
      },
    ]);
    expect(merge.result).toEqual({
      'a/b': { '~headers': [{ name: 'accept', value: 'yaml' }] },
    });
  });

  it('reports delete versus edit and applies an explicit incoming choice', () => {
    const merge = createStructuredMerge(
      { request: { auth: { type: 'bearer', token: '{{TOKEN}}' } } },
      { request: {} },
      { request: { auth: { type: 'bearer', token: '{{NEXT_TOKEN}}' } } }
    );

    expect(merge.conflicts.map((conflict) => conflict.path)).toEqual(['/request/auth']);
    expect(merge.conflicts[0]?.local).toEqual({ present: false });

    expect(applyStructuredChoices(merge, { '/request/auth': 'incoming' })).toEqual({
      request: { auth: { type: 'bearer', token: '{{NEXT_TOKEN}}' } },
    });
  });

  it('can resolve an add/add conflict by deleting the path', () => {
    const merge = createStructuredMerge(
      {},
      { docs: 'local documentation' },
      { docs: 'incoming documentation' }
    );

    expect(merge.conflicts[0]?.base).toEqual({ present: false });
    expect(applyStructuredChoices(merge, { '/docs': 'delete' })).toEqual({});
  });

  it('rejects missing and unknown conflict choices', () => {
    const merge = createStructuredMerge({ value: 1 }, { value: 2 }, { value: 3 });

    expect(() => applyStructuredChoices(merge, {})).toThrow(/choice.*\/value/i);
    expect(() =>
      applyStructuredChoices(merge, { '/value': 'local', '/unknown': 'incoming' })
    ).toThrow(/unknown conflict path/i);
  });

  it('applies base and local choices at root and nested paths', () => {
    const rootMerge = createStructuredMerge('base', 'local', 'incoming');
    expect(applyStructuredChoices(rootMerge, { '': 'base' })).toBe('base');
    expect(applyStructuredChoices(rootMerge, { '': 'local' })).toBe('local');
    expect(applyStructuredChoices(rootMerge, { '': 'delete' })).toBeUndefined();

    expect(
      applyStructuredChoices(
        {
          result: 'primitive',
          conflicts: [
            {
              path: '/field',
              base: { present: true, value: 'base' },
              local: { present: true, value: 'local' },
              incoming: { present: true, value: 'incoming' },
            },
          ],
        },
        { '/field': 'incoming' }
      )
    ).toEqual({ field: 'incoming' });

    expect(
      applyStructuredChoices(
        {
          result: { nested: 'replace me', removed: true },
          conflicts: [
            {
              path: '/nested/value',
              base: { present: true, value: 'base' },
              local: { present: true, value: 'local' },
              incoming: { present: true, value: 'incoming' },
            },
            {
              path: '/removed',
              base: { present: true, value: true },
              local: { present: true, value: true },
              incoming: { present: false },
            },
          ],
        },
        { '/nested/value': 'base', '/removed': 'incoming' }
      )
    ).toEqual({ nested: { value: 'base' } });
  });

  it('distinguishes array shape, primitive, and null-prototype mapping values', () => {
    expect(createStructuredMerge([1], [1, 2], { 0: 1 }).conflicts).toHaveLength(1);
    expect(createStructuredMerge([1], [1, 2], [1, 2, 3]).conflicts).toHaveLength(1);

    const base = Object.assign(Object.create(null) as Record<string, unknown>, {
      shared: 'base',
      localOnly: 'base',
      incomingOnly: 'base',
    });
    const local = Object.assign(Object.create(null) as Record<string, unknown>, base, {
      localOnly: 'local',
    });
    const incoming = Object.assign(Object.create(null) as Record<string, unknown>, base, {
      incomingOnly: 'incoming',
    });
    expect(createStructuredMerge(base, local, incoming)).toMatchObject({
      conflicts: [],
      result: { shared: 'base', localOnly: 'local', incomingOnly: 'incoming' },
    });
  });
});
