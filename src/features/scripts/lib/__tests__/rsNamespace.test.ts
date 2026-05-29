import { describe, it, expect } from 'vitest';
import ScriptExecutor from '../scriptExecutor';

/**
 * `rs.*` is Restura's native sandbox namespace. It is bound as a live alias to
 * the same object as `pm.*` (scriptExecutor.ts), so the full pm surface is
 * reachable via rs, and writes through one namespace are visible via the other.
 */

const baseResponse = {
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  body: { id: 42, name: 'alice' },
  time: 120,
  size: 256,
};

async function runScript(script: string, envVars: Record<string, string> = {}) {
  const executor = new ScriptExecutor({ envVars, globalVars: {} });
  return executor.executeScript(script, { response: baseResponse });
}

describe('rs.* native namespace', () => {
  it('rs.test + rs.expect work against rs.response', async () => {
    const r = await runScript(`
      rs.test('status is 200', function () {
        rs.expect(rs.response.code).to.equal(200);
      });
      rs.test('has name', function () {
        rs.expect(rs.response.json()).to.have.property('name');
      });
    `);
    expect(r.tests).toEqual([
      { name: 'status is 200', passed: true },
      { name: 'has name', passed: true },
    ]);
  });

  it('rs and pm reference the same object — writes are visible across both', async () => {
    const r = await runScript(`
      rs.variables.set('viaRs', 'one');
      pm.variables.set('viaPm', 'two');
      rs.test('pm sees rs write', function () {
        rs.expect(pm.variables.get('viaRs')).to.equal('one');
      });
      rs.test('rs sees pm write', function () {
        rs.expect(rs.variables.get('viaPm')).to.equal('two');
      });
    `);
    expect(r.tests?.every((t) => t.passed)).toBe(true);
    expect(r.tests).toHaveLength(2);
  });

  it('rs.info is the same mutable object as pm.info', async () => {
    const r = await runScript(`
      rs.test('identity', function () {
        rs.expect(rs.info === pm.info).to.be.true;
      });
    `);
    expect(r.tests?.[0]?.passed).toBe(true);
  });

  it('exposes the core pm.* surface via rs.* (same object as pm)', async () => {
    const r = await runScript(`
      rs.test('surface', function () {
        rs.expect(rs.test).to.be.a('function');
        rs.expect(rs.expect).to.be.a('function');
        rs.expect(rs.variables).to.be.an('object');
        rs.expect(rs.globals).to.be.an('object');
        rs.expect(rs.environment).to.be.an('object');
        rs.expect(rs.collectionVariables).to.be.an('object');
        rs.expect(rs.cookies).to.be.an('object');
        rs.expect(rs.iterationData).to.be.an('object');
        rs.expect(rs.vault === pm.vault).to.be.true;
        rs.expect(rs.cookies === pm.cookies).to.be.true;
      });
    `);
    expect(r.tests?.[0]?.passed).toBe(true);
  });
});
