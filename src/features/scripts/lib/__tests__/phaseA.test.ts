import { describe, expect, it } from 'vitest';
import ScriptExecutor from '../scriptExecutor';

/**
 * Phase A integration: prove the sentinel-harvest flow end-to-end.
 *
 * The unit-level pmShim suite covers `pm.test` / `pm.expect` /
 * `pm.environment` / `pm.globals` behaviour. This suite asserts the new
 * surfaces Phase A adds:
 *
 *   - `pm.globals.set/unset`           → `result.globalsMutations`
 *   - `pm.collectionVariables.set/unset` → `result.collectionMutations`
 *   - `pm.execution.setNextRequest`    → `result.execution.nextRequest`
 *   - `pm.execution.skipRequest`       → `result.execution.skipRequested`
 *   - `pm.visualizer.set`              → `result.visualization`
 *   - `pm.iterationData`               → reads the per-call iteration row
 *   - `pm.execution.location`          → reads the configured location
 *
 * These are the load-bearing surfaces the renderer/runner consume to wire
 * the script sandbox into the rest of the app (HTTP/gRPC executors merge
 * globals back into `useGlobalsStore`; Phase C's collection runner reads
 * `execution` to drive flow control).
 */
describe('Phase A — mutation + execution sentinel harvest', () => {
  it('surfaces pm.globals.set / unset as globalsMutations', async () => {
    const executor = new ScriptExecutor({ globalVars: { existing: 'keep' } });
    const result = await executor.executeScript(
      `
      pm.globals.set('region', 'us-east-1');
      pm.globals.set('token', 'abc123');
      pm.globals.unset('existing');
    `,
      {}
    );
    expect(result.globalsMutations).toEqual({
      region: 'us-east-1',
      token: 'abc123',
      existing: null,
    });
  });

  it('omits globalsMutations when the script does not touch pm.globals', async () => {
    const executor = new ScriptExecutor({});
    const result = await executor.executeScript(`pm.test('noop', function () {});`, {});
    expect(result.globalsMutations).toBeUndefined();
  });

  it('surfaces pm.collectionVariables mutations separately from env', async () => {
    const executor = new ScriptExecutor({});
    const result = await executor.executeScript(
      `
      pm.collectionVariables.set('base', 'https://api.example.com');
      pm.collectionVariables.unset('stale');
    `,
      {}
    );
    expect(result.collectionMutations).toEqual({
      base: 'https://api.example.com',
      stale: null,
    });
    // env is untouched
    expect(result.variables).toEqual({});
  });

  it('surfaces pm.execution.setNextRequest', async () => {
    const executor = new ScriptExecutor({});
    const result = await executor.executeScript(`pm.execution.setNextRequest('Login');`, {});
    expect(result.execution).toEqual({ nextRequest: 'Login' });
  });

  it('setNextRequest(null) explicitly ends the iteration', async () => {
    const executor = new ScriptExecutor({});
    const result = await executor.executeScript(`pm.execution.setNextRequest(null);`, {});
    expect(result.execution).toEqual({ nextRequest: null });
  });

  it('surfaces pm.execution.skipRequest', async () => {
    const executor = new ScriptExecutor({});
    const result = await executor.executeScript(`pm.execution.skipRequest();`, {});
    expect(result.execution).toEqual({ skipRequested: true });
  });

  it('captures pm.visualizer.set into result.visualization', async () => {
    const executor = new ScriptExecutor({});
    const result = await executor.executeScript(
      `pm.visualizer.set('<h1>{{title}}</h1>', { title: 'Hello' });`,
      {}
    );
    expect(result.visualization).toEqual({
      template: '<h1>{{title}}</h1>',
      data: { title: 'Hello' },
    });
  });

  it('omits visualization when pm.visualizer.set is not called', async () => {
    const executor = new ScriptExecutor({});
    const result = await executor.executeScript(`pm.test('noop', function () {});`, {});
    expect(result.visualization).toBeUndefined();
  });

  it('pm.iterationData reads the per-call row', async () => {
    const executor = new ScriptExecutor({
      iterationData: { user: 'alice', plan: 'pro' },
    });
    const result = await executor.executeScript(
      `
      pm.test('user', function () { pm.expect(pm.iterationData.get('user')).to.equal('alice'); });
      pm.test('plan', function () { pm.expect(pm.iterationData.get('plan')).to.equal('pro'); });
      pm.test('missing', function () { pm.expect(pm.iterationData.has('nope')).to.be.false; });
    `,
      {}
    );
    expect(result.tests?.every((t) => t.passed)).toBe(true);
  });

  it('pm.execution.location is bound from per-call context', async () => {
    const executor = new ScriptExecutor({});
    const result = await executor.executeScript(
      `
      pm.test('name', function () { pm.expect(pm.execution.location.currentRequestName).to.equal('Login'); });
      pm.test('folders', function () { pm.expect(pm.execution.location.folderPath.length).to.equal(2); });
      pm.test('collection', function () { pm.expect(pm.execution.location.collectionName).to.equal('Auth Flow'); });
    `,
      {
        location: {
          currentRequestName: 'Login',
          folderPath: ['Auth', 'OAuth'],
          collectionName: 'Auth Flow',
        },
      }
    );
    expect(result.tests?.every((t) => t.passed)).toBe(true);
  });

  it('per-eval sentinel state is isolated across reused sessions', async () => {
    // The first call sets nextRequest; the second call doesn't touch it and
    // should not see leaked state from the prior call.
    const executor = new ScriptExecutor({});
    await executor.initialize();
    const r1 = await executor.eval(`pm.execution.setNextRequest('A');`, {});
    expect(r1.execution).toEqual({ nextRequest: 'A' });
    const r2 = await executor.eval(`pm.test('noop', function () {});`, {});
    expect(r2.execution).toBeUndefined();
    executor.dispose();
  });
});
