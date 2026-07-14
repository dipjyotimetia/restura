import { describe, expect, it } from 'vitest';
import ScriptExecutor from '../scriptExecutor';

/**
 * Postman-parity gap-closing suite: `pm.info.eventName`, a
 * never-undefined `pm.execution.location`, the legacy `postman.*` API,
 * and the legacy `tests["label"] = bool` object style. These close real
 * gaps found in a review of Restura's script sandbox against Postman's
 * documented sandbox API — see the corresponding requestExecutor /
 * useHttpRequestPage / grpc protocol / collectionRunner / CLI runner
 * wiring changes that populate `info` / `location` / `collectionVars` /
 * `iterationData` for real (not just default-empty) values.
 */
describe('Postman parity — pm.info.eventName, pm.execution.location defaults, legacy APIs', () => {
  it('pm.info.eventName reflects the caller-supplied phase', async () => {
    const executor = new ScriptExecutor({ info: { eventName: 'prerequest' } });
    const result = await executor.executeScript(
      `pm.test('phase', function () { pm.expect(pm.info.eventName).to.equal('prerequest'); });`,
      {}
    );
    expect(result.tests?.every((t) => t.passed)).toBe(true);
  });

  it('pm.info.eventName defaults to empty string when not supplied', async () => {
    const executor = new ScriptExecutor({});
    const result = await executor.executeScript(
      `pm.test('phase', function () { pm.expect(pm.info.eventName).to.equal(''); });`,
      {}
    );
    expect(result.tests?.every((t) => t.passed)).toBe(true);
  });

  it('pm.execution.location is always a defined object, even with no runner context', async () => {
    // A one-off "Send" (no collection run) must not throw a TypeError when
    // a script unconditionally reads pm.execution.location.collectionName —
    // a pattern real Postman collection scripts commonly use.
    const executor = new ScriptExecutor({});
    const result = await executor.executeScript(
      `
      pm.test('never throws', function () {
        pm.expect(pm.execution.location.collectionName).to.equal('');
        pm.expect(pm.execution.location.currentRequestName).to.equal('');
        pm.expect(pm.execution.location.folderPath).to.eql([]);
      });
    `,
      {}
    );
    expect(result.errors).toEqual([]);
    expect(result.tests?.every((t) => t.passed)).toBe(true);
  });

  it('legacy postman.* aliases delegate to pm.environment / pm.globals', async () => {
    const executor = new ScriptExecutor({ envVars: { existing: 'x' }, globalVars: {} });
    const result = await executor.executeScript(
      `
      postman.setEnvironmentVariable('token', 'abc');
      pm.test('env get', function () {
        pm.expect(postman.getEnvironmentVariable('token')).to.equal('abc');
      });
      postman.clearEnvironmentVariable('existing');
      pm.test('env cleared', function () {
        pm.expect(pm.environment.has('existing')).to.be.false;
      });
      postman.setGlobalVariable('region', 'us-east-1');
      pm.test('global get', function () {
        pm.expect(postman.getGlobalVariable('region')).to.equal('us-east-1');
      });
      postman.clearGlobalVariable('region');
      pm.test('global cleared', function () {
        pm.expect(pm.globals.has('region')).to.be.false;
      });
    `,
      {}
    );
    expect(result.tests?.every((t) => t.passed)).toBe(true);
  });

  it('legacy postman.setNextRequest delegates to pm.execution.setNextRequest', async () => {
    const executor = new ScriptExecutor({});
    const result = await executor.executeScript(`postman.setNextRequest('Login');`, {});
    expect(result.execution).toEqual({ nextRequest: 'Login' });
  });

  it('legacy tests["label"] = bool records a pm.test outcome', async () => {
    const executor = new ScriptExecutor({});
    const result = await executor.executeScript(
      `
      tests['status is 200'] = true;
      tests['body has id'] = false;
    `,
      {}
    );
    expect(result.tests).toEqual([
      { name: 'status is 200', passed: true },
      { name: 'body has id', passed: false, error: 'Test failed: body has id' },
    ]);
  });

  it('pm.response status-class matchers (clientError/serverError/success/etc)', async () => {
    const executor = new ScriptExecutor({});
    const result = await executor.executeScript(
      `
      pm.test('client error', function () { pm.response.to.be.clientError(); });
      pm.test('not server error', function () {
        var threw = false;
        try { pm.response.to.be.serverError(); } catch (e) { threw = true; }
        pm.expect(threw).to.be.true;
      });
    `,
      {
        response: { status: 404, statusText: 'Not Found', headers: {}, body: '', time: 1, size: 0 },
      }
    );
    expect(result.tests?.every((t) => t.passed)).toBe(true);
  });
});
