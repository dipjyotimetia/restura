import { describe, expect, it } from 'vitest';
import {
  APP_SCOPE_POLICY,
  CLI_SCOPE_POLICY,
  RunScope,
  type RunScopeInit,
  type VarMap,
} from './scope';

function scopeFor(
  policy: RunScopeInit['policy'],
  layers: Partial<Omit<RunScopeInit, 'policy' | 'collection'>> & { collection?: VarMap } = {}
) {
  return new RunScope({ policy, ...layers, collection: layers.collection ?? {} });
}

/** A phase that wrote `writes` over `before`. */
const wrote = (before: VarMap, writes: VarMap) => ({ before, after: { ...before, ...writes } });

describe.each([
  ['app', APP_SCOPE_POLICY],
  ['CLI', CLI_SCOPE_POLICY],
])('RunScope — shared precedence (%s policy)', (_name, policy) => {
  it('layers environment < collection < folder < data row', () => {
    const scope = scopeFor(policy, {
      environment: { a: 'env', b: 'env', c: 'env', d: 'env' },
      collection: { b: 'collection', c: 'collection', d: 'collection' },
    });
    const iter = scope.beginIteration({ d: 'row' });
    expect(iter.requestVars({ c: 'folder', d: 'folder' })).toEqual({
      a: 'env',
      b: 'collection',
      c: 'folder',
      d: 'row',
    });
  });

  it('a script write this iteration beats the data row', () => {
    const iter = scopeFor(policy).beginIteration({ x: 'row' });
    const start = iter.requestVars();
    iter.absorb([wrote(start, { x: 'script' })]);
    expect(iter.requestVars().x).toBe('script');
  });

  it('a write from an earlier iteration sits below the next data row', () => {
    const scope = scopeFor(policy);
    const first = scope.beginIteration({ x: 'row1' });
    first.absorb([wrote(first.requestVars(), { x: 'script' })]);
    first.end();
    const second = scope.beginIteration({ x: 'row2' });
    expect(second.requestVars().x).toBe('row2');
  });

  it('a write from an earlier iteration carries when the next row lacks the key', () => {
    const scope = scopeFor(policy);
    const first = scope.beginIteration({ id: '1' });
    first.absorb([wrote(first.requestVars(), { token: 'T' })]);
    first.end();
    expect(scope.beginIteration({ id: '2' }).requestVars()).toEqual({ id: '2', token: 'T' });
  });

  it('an iteration that does not end does not carry its overrides', () => {
    const scope = scopeFor(policy);
    const first = scope.beginIteration({});
    first.absorb([wrote(first.requestVars(), { token: 'T' })]);
    // The row outranks carried overrides, and retained writes sit below it too.
    expect(scope.beginIteration({ token: 'row' }).requestVars().token).toBe('row');
    const next = scope.beginIteration({}).requestVars().token;
    expect(next).toBe(policy.retainWrites ? 'T' : undefined);
  });

  it('an untouched folder default or row value is not written back', () => {
    const scope = scopeFor(policy);
    const first = scope.beginIteration({ id: '1' });
    const start = first.requestVars({ host: 'folder' });
    first.absorb([{ before: start, after: { ...start } }]);
    first.end();
    expect(scope.beginIteration({}).requestVars()).toEqual({});
  });

  it('a write is judged against the map the phase started from', () => {
    const iter = scopeFor(policy).beginIteration({});
    const before = { x: '1' };
    iter.absorb([{ before, after: { x: '1', y: '2' } }]);
    expect(iter.requestVars()).toEqual({ y: '2' });
  });

  it('collection writes land in the live collection map and cancel a same-key variable write', () => {
    const collection: VarMap = { token: 'old' };
    const iter = scopeFor(policy, { collection }).beginIteration({});
    const start = iter.requestVars();
    const merged = iter.absorb([
      {
        ...wrote(start, { token: 'new', other: 'o' }),
        collectionMutations: { token: 'new' },
      },
    ]);
    expect(merged).toEqual({ token: 'new' });
    expect(collection).toEqual({ token: 'new' });
    expect(iter.requestVars().other).toBe('o');
  });

  it('a collection write sits below the data row', () => {
    const iter = scopeFor(policy).beginIteration({ token: 'row' });
    iter.absorb([{ before: {}, after: {}, collectionMutations: { token: 'collection' } }]);
    expect(iter.requestVars().token).toBe('row');
  });

  it('merges collection writes across phases, the later phase winning', () => {
    const collection: VarMap = {};
    const iter = scopeFor(policy, { collection }).beginIteration({});
    const merged = iter.absorb([
      { before: {}, after: {}, collectionMutations: { a: '1', b: '1' } },
      { before: {}, after: {}, collectionMutations: { a: '2', b: null } },
    ]);
    expect(merged).toEqual({ a: '2', b: null });
    expect(collection).toEqual({ a: '2' });
  });
});

describe('RunScope — app policy', () => {
  const policy = APP_SCOPE_POLICY;

  it('globals sit below everything and are mutated by globals writes', () => {
    const globals: VarMap = { g: 'global', e: 'global' };
    const scope = scopeFor(policy, { globals, environment: { e: 'env' } });
    const iter = scope.beginIteration({});
    expect(iter.requestVars()).toEqual({ g: 'global', e: 'env' });
    iter.absorb([{ before: {}, after: {}, globalsMutations: { g: 'changed', gone: null } }]);
    expect(globals).toEqual({ g: 'changed', e: 'global' });
  });

  it('a collection write is substituted into later requests', () => {
    const iter = scopeFor(policy).beginIteration({});
    iter.absorb([{ before: {}, after: {}, collectionMutations: { token: 'abc' } }]);
    expect(iter.requestVars().token).toBe('abc');
  });

  it('a write from an earlier iteration sits BELOW a folder variable', () => {
    const scope = scopeFor(policy);
    const first = scope.beginIteration({});
    first.absorb([wrote(first.requestVars({ host: 'folder' }), { host: 'script' })]);
    first.end();
    expect(scope.beginIteration({}).requestVars({ host: 'folder' }).host).toBe('folder');
  });

  it('a write from an earlier iteration sits BELOW a collection variable', () => {
    const scope = scopeFor(policy, { collection: { k: 'collection' } });
    const first = scope.beginIteration({});
    first.absorb([wrote(first.requestVars(), { k: 'script' })]);
    first.end();
    expect(scope.beginIteration({}).requestVars().k).toBe('collection');
  });

  it('a write from an earlier iteration sits ABOVE the environment', () => {
    const scope = scopeFor(policy, { environment: { k: 'env' } });
    const first = scope.beginIteration({});
    first.absorb([wrote(first.requestVars(), { k: 'script' })]);
    first.end();
    expect(scope.beginIteration({}).requestVars().k).toBe('script');
  });

  // The CLI sits the other way; the choice is unresolved, so both are pinned.
  it.todo(
    'DIVERGENCE: earlier-iteration script writes sit below folder/collection variables in the app, above folder variables in the CLI'
  );
});

describe('RunScope — CLI policy', () => {
  const policy = CLI_SCOPE_POLICY;

  it('--env-var overrides sit above folder variables and below the data row', () => {
    const scope = scopeFor(policy, {
      environment: { a: 'env' },
      collection: { a: 'collection', b: 'collection' },
      overrides: { a: 'override', b: 'override', c: 'override' },
    });
    expect(scope.beginIteration({ c: 'row' }).requestVars({ a: 'folder', b: 'folder' })).toEqual({
      a: 'override',
      b: 'override',
      c: 'row',
    });
  });

  it('ignores globals writes (the CLI has no pm.globals scope)', () => {
    const iter = scopeFor(policy).beginIteration({});
    iter.absorb([{ before: {}, after: {}, globalsMutations: { g: '1' } }]);
    expect(iter.requestVars()).toEqual({});
  });

  it('a collection write is NOT substituted into later requests', () => {
    const collection: VarMap = {};
    const iter = scopeFor(policy, { collection }).beginIteration({});
    iter.absorb([{ before: {}, after: {}, collectionMutations: { token: 'abc' } }]);
    expect(iter.requestVars().token).toBeUndefined();
    expect(collection.token).toBe('abc');
  });

  it('a write from an earlier iteration sits ABOVE folder and collection variables', () => {
    const scope = scopeFor(policy, { collection: { k: 'collection' } });
    const first = scope.beginIteration({});
    first.absorb([wrote(first.requestVars({ host: 'folder' }), { host: 'script', k: 'script' })]);
    first.end();
    const second = scope.beginIteration({}).requestVars({ host: 'folder' });
    expect(second).toMatchObject({ host: 'script', k: 'script' });
  });

  it('a later collection write cancels the override; the value stays retained', () => {
    const scope = scopeFor(policy);
    const first = scope.beginIteration({});
    first.absorb([wrote(first.requestVars(), { k: 'script' })]);
    first.end();
    const second = scope.beginIteration({});
    second.absorb([{ before: {}, after: {}, collectionMutations: { k: 'collection' } }]);
    expect(second.requestVars().k).toBe('script');
    expect(second.requestVars({ k: 'folder' }).k).toBe('folder');
  });
});

describe('RunScope — retained writes', () => {
  it('CLI: a variable write stays substitutable after a same-key collection write', () => {
    const scope = scopeFor(CLI_SCOPE_POLICY, { environment: { t: 'start' } });
    const iter = scope.beginIteration({});
    const before = iter.requestVars();
    iter.absorb([
      { before, after: { ...before, t: 'fresh' }, collectionMutations: { t: 'fresh' } },
    ]);
    expect(iter.requestVars().t).toBe('fresh');
  });

  it('CLI: the retained write outlives the iteration and sits below folder variables', () => {
    const scope = scopeFor(CLI_SCOPE_POLICY);
    const iter = scope.beginIteration({});
    const before = iter.requestVars();
    iter.absorb([{ before, after: { ...before, t: 'fresh' }, collectionMutations: { t: 'c' } }]);
    iter.end();
    const next = scope.beginIteration({});
    expect(next.requestVars().t).toBe('fresh');
    expect(next.requestVars({ t: 'folder' }).t).toBe('folder');
  });

  it('app: a collection unset hides lower scopes until the iteration ends', () => {
    const scope = scopeFor(APP_SCOPE_POLICY, {
      environment: { k: 'env' },
      collection: { k: 'col' },
    });
    const iter = scope.beginIteration({ rowKey: 'r' });
    const before = iter.requestVars();
    iter.absorb([{ before, after: before, collectionMutations: { k: null } }]);
    expect('k' in iter.requestVars()).toBe(false);
    expect(iter.requestVars({ k: 'folder' }).k).toBe('folder');
    iter.end();
    expect(scope.beginIteration({}).requestVars().k).toBe('env');
  });

  it('app: a later collection set clears the unset; a row value survives one', () => {
    const scope = scopeFor(APP_SCOPE_POLICY, { environment: { k: 'env' } });
    const iter = scope.beginIteration({ inRow: 'row' });
    const before = iter.requestVars();
    iter.absorb([{ before, after: before, collectionMutations: { k: null, inRow: null } }]);
    expect(iter.requestVars().inRow).toBe('row');
    iter.absorb([{ before, after: before, collectionMutations: { k: 'back' } }]);
    expect(iter.requestVars().k).toBe('back');
  });
});
