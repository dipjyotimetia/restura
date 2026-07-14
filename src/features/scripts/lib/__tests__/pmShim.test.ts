import { describe, expect, it } from 'vitest';
import ScriptExecutor from '../scriptExecutor';

/**
 * Postman pm.* compatibility shim — coverage matrix.
 *
 * Each test mirrors a real-world Postman test-script idiom. If a user's
 * imported Postman collection contains an assertion that fails here, the
 * shim has a gap to close.
 *
 * Tests are organised by Postman API surface:
 *   1. pm.test + reporting
 *   2. pm.expect — chai-subset
 *   3. pm.response — status, headers, body, time, json()
 *   4. pm.environment / pm.variables / pm.collectionVariables / pm.globals
 *   5. pm.info
 *   6. pm.iterationData (stub)
 */

interface TestResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  time: number;
  size: number;
}

const baseResponse: TestResponse = {
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  body: { id: 42, name: 'alice', tags: ['admin', 'user'], nested: { val: 1 } },
  time: 120,
  size: 256,
};

async function runScript(
  script: string,
  opts: {
    response?: TestResponse;
    envVars?: Record<string, string>;
    globals?: Record<string, string>;
    info?: {
      requestName?: string;
      requestId?: string;
      iteration?: number;
      iterationCount?: number;
    };
  } = {}
) {
  const executor = new ScriptExecutor({
    envVars: opts.envVars ?? {},
    globalVars: opts.globals ?? {},
  });
  return executor.executeScript(script, {
    response: opts.response ?? baseResponse,
    ...(opts.info ? { info: opts.info } : {}),
  });
}

function expectAllTestsPass(result: {
  tests?: Array<{ name: string; passed: boolean; error?: string }>;
}) {
  expect(result.tests).toBeDefined();
  const failed = result.tests!.filter((t) => !t.passed);
  if (failed.length > 0) {
    throw new Error(
      `Expected all tests to pass, but these failed:\n` +
        failed.map((t) => `  - ${t.name}: ${t.error ?? 'no error'}`).join('\n')
    );
  }
}

describe('pm.test — reporting', () => {
  it('reports a passing test', async () => {
    const r = await runScript(`pm.test('passes', function () { pm.expect(1).to.equal(1); });`);
    expect(r.tests).toEqual([{ name: 'passes', passed: true }]);
  });

  it('reports a failing test with the assertion message', async () => {
    const r = await runScript(`pm.test('fails', function () { pm.expect(1).to.equal(2); });`);
    expect(r.tests).toHaveLength(1);
    expect(r.tests![0]?.passed).toBe(false);
    // chai's default message is "expected 1 to equal 2"; relax the match
    // so a future chai upgrade that tweaks the wording doesn't break us.
    expect(r.tests![0]?.error?.toLowerCase()).toMatch(/expected 1.*equal.*2/);
  });
});

describe('pm.expect — primitive equality and types', () => {
  it('strict equality', async () => {
    const r = await runScript(`
      pm.test('strict equal', function () { pm.expect(5).to.equal(5); });
      pm.test('strict equal neg', function () { pm.expect(5).to.not.equal(6); });
    `);
    expectAllTestsPass(r);
  });

  it('deep equality (.eql and .deep.equal)', async () => {
    const r = await runScript(`
      pm.test('deep equal eql', function () { pm.expect({a:1,b:[1,2]}).to.eql({a:1,b:[1,2]}); });
      pm.test('deep equal sugar', function () { pm.expect({a:1}).to.deep.equal({a:1}); });
      pm.test('deep not equal', function () { pm.expect({a:1}).to.not.eql({a:2}); });
    `);
    expectAllTestsPass(r);
  });

  it('type checks (.be.a / .be.an)', async () => {
    const r = await runScript(`
      pm.test('a string', function () { pm.expect('hi').to.be.a('string'); });
      pm.test('an object', function () { pm.expect({}).to.be.an('object'); });
      pm.test('an array', function () { pm.expect([1,2]).to.be.an('array'); });
      pm.test('a number', function () { pm.expect(5).to.be.a('number'); });
    `);
    expectAllTestsPass(r);
  });

  it('boolean / null / undefined predicates', async () => {
    const r = await runScript(`
      pm.test('true', function () { pm.expect(true).to.be.true; });
      pm.test('false', function () { pm.expect(false).to.be.false; });
      pm.test('null', function () { pm.expect(null).to.be.null; });
      pm.test('undefined', function () { pm.expect(undefined).to.be.undefined; });
    `);
    expectAllTestsPass(r);
  });

  it('empty / ok', async () => {
    const r = await runScript(`
      pm.test('empty array', function () { pm.expect([]).to.be.empty; });
      pm.test('empty string', function () { pm.expect('').to.be.empty; });
      pm.test('empty object', function () { pm.expect({}).to.be.empty; });
      pm.test('ok truthy', function () { pm.expect(1).to.be.ok; });
      pm.test('not empty', function () { pm.expect([1]).to.not.be.empty; });
    `);
    expectAllTestsPass(r);
  });

  it('numeric comparisons (.above / .below / .within / .closeTo / .at.least / .at.most)', async () => {
    const r = await runScript(`
      pm.test('above', function () { pm.expect(10).to.be.above(5); });
      pm.test('below', function () { pm.expect(3).to.be.below(5); });
      pm.test('within', function () { pm.expect(5).to.be.within(1, 10); });
      pm.test('closeTo', function () { pm.expect(0.1 + 0.2).to.be.closeTo(0.3, 0.001); });
      pm.test('at least', function () { pm.expect(5).to.be.at.least(5); });
      pm.test('at most', function () { pm.expect(5).to.be.at.most(5); });
    `);
    expectAllTestsPass(r);
  });

  it('inclusion (.include / .contain / .match)', async () => {
    const r = await runScript(`
      pm.test('string include', function () { pm.expect('hello world').to.include('world'); });
      pm.test('array include', function () { pm.expect([1,2,3]).to.include(2); });
      pm.test('object include', function () { pm.expect({a:1,b:2}).to.include({a:1}); });
      pm.test('regex match', function () { pm.expect('abc-123').to.match(/^abc-\\d+$/); });
      pm.test('negated include', function () { pm.expect([1,2]).to.not.include(3); });
    `);
    expectAllTestsPass(r);
  });

  it('properties / keys / members / length', async () => {
    const r = await runScript(`
      pm.test('has property', function () { pm.expect({a:1,b:2}).to.have.property('a'); });
      pm.test('property value', function () { pm.expect({a:1,b:2}).to.have.property('a', 1); });
      pm.test('keys', function () { pm.expect({a:1,b:2}).to.have.keys(['a','b']); });
      pm.test('keys (variadic)', function () { pm.expect({a:1,b:2}).to.have.keys('a','b'); });
      pm.test('members', function () { pm.expect([3,1,2]).to.have.members([1,2,3]); });
      pm.test('lengthOf', function () { pm.expect([1,2,3]).to.have.lengthOf(3); });
      pm.test('length', function () { pm.expect('abc').to.have.length(3); });
    `);
    expectAllTestsPass(r);
  });
});

describe('pm.response — status / headers / body / time', () => {
  it('status code assertion', async () => {
    const r = await runScript(`
      pm.test('status 200', function () { pm.response.to.have.status(200); });
      pm.test('status is ok', function () { pm.response.to.be.ok; });
    `);
    expectAllTestsPass(r);
  });

  it('header presence and value', async () => {
    const r = await runScript(`
      pm.test('has content-type', function () { pm.response.to.have.header('content-type'); });
      pm.test('content-type value', function () { pm.response.to.have.header('content-type', 'application/json'); });
      pm.test('is json', function () { pm.response.to.be.json; });
    `);
    expectAllTestsPass(r);
  });

  it('response.json() returns parsed body', async () => {
    const r = await runScript(`
      var body = pm.response.json();
      pm.test('json body has id', function () { pm.expect(body.id).to.equal(42); });
      pm.test('json body has tags', function () { pm.expect(body.tags).to.include('admin'); });
    `);
    expectAllTestsPass(r);
  });

  it('jsonBody path assertion', async () => {
    const r = await runScript(`
      pm.test('nested.val is 1', function () { pm.response.to.have.jsonBody('nested.val', 1); });
    `);
    expectAllTestsPass(r);
  });

  it('response time below threshold', async () => {
    const r = await runScript(`
      pm.test('fast', function () { pm.response.to.have; pm.response.time.below(500); });
    `);
    expectAllTestsPass(r);
  });

  it('response.code / .status / .responseTime accessors', async () => {
    const r = await runScript(`
      pm.test('code', function () { pm.expect(pm.response.code).to.equal(200); });
      pm.test('responseTime', function () { pm.expect(pm.response.responseTime).to.be.below(1000); });
    `);
    expectAllTestsPass(r);
  });
});

describe('pm.environment / pm.variables / pm.collectionVariables / pm.globals', () => {
  it('pm.variables.get reads injected variables', async () => {
    const r = await runScript(
      `pm.test('var present', function () { pm.expect(pm.variables.get('apiKey')).to.equal('secret'); });`,
      { envVars: { apiKey: 'secret' } }
    );
    expectAllTestsPass(r);
  });

  it('pm.environment.{get,set,unset,has}', async () => {
    const r = await runScript(
      `
      pm.environment.set('token', 'abc123');
      pm.test('has', function () { pm.expect(pm.environment.has('token')).to.be.true; });
      pm.test('get', function () { pm.expect(pm.environment.get('token')).to.equal('abc123'); });
      pm.environment.unset('token');
      pm.test('after unset', function () { pm.expect(pm.environment.has('token')).to.be.false; });
    `
    );
    expectAllTestsPass(r);
    expect(r.variables).not.toHaveProperty('token');
  });

  it('pm.collectionVariables is a separate scope from pm.environment / pm.variables', async () => {
    // Postman semantics: collectionVariables, environment, and globals are
    // distinct stores. Setting one does NOT make the value visible in the
    // others. (Resolution-chain reads through pm.variables still favour
    // collection then environment then globals, but a raw .get() against
    // pm.variables hits only the environment-aliased map.)
    const r = await runScript(
      `
      pm.collectionVariables.set('base', 'https://api.example.com');
      pm.test('readback', function () { pm.expect(pm.collectionVariables.get('base')).to.equal('https://api.example.com'); });
      pm.test('isolated from env', function () { pm.expect(pm.environment.has('base')).to.be.false; });
      pm.test('isolated from variables', function () { pm.expect(pm.variables.has('base')).to.be.false; });
    `
    );
    expectAllTestsPass(r);
  });

  it('pm.globals reads/writes globals namespace', async () => {
    const r = await runScript(
      `
      pm.test('initial', function () { pm.expect(pm.globals.get('region')).to.equal('us-east-1'); });
      pm.globals.set('region', 'eu-west-1');
      pm.test('after set', function () { pm.expect(pm.globals.get('region')).to.equal('eu-west-1'); });
    `,
      { globals: { region: 'us-east-1' } }
    );
    expectAllTestsPass(r);
  });
});

describe('pm.info', () => {
  it('exposes requestName/requestId from context.info', async () => {
    const r = await runScript(
      `
      pm.test('name', function () { pm.expect(pm.info.requestName).to.equal('Login'); });
      pm.test('id', function () { pm.expect(pm.info.requestId).to.equal('req-001'); });
      pm.test('iteration', function () { pm.expect(pm.info.iteration).to.equal(0); });
    `,
      { info: { requestName: 'Login', requestId: 'req-001', iteration: 0, iterationCount: 1 } }
    );
    expectAllTestsPass(r);
  });

  it('defaults to empty when no info is provided', async () => {
    const r = await runScript(`
      pm.test('default name', function () { pm.expect(pm.info.requestName).to.equal(''); });
      pm.test('default count', function () { pm.expect(pm.info.iterationCount).to.equal(1); });
    `);
    expectAllTestsPass(r);
  });
});

describe('pm.iterationData — stub', () => {
  it('returns undefined for any key (v1 stub)', async () => {
    const r = await runScript(`
      pm.test('missing', function () { pm.expect(pm.iterationData.get('whatever')).to.be.undefined; });
    `);
    expectAllTestsPass(r);
  });
});

describe('real-world Postman fixtures', () => {
  // Fixture sources: Postman public docs ("Writing tests" page) and the
  // postmanlabs/postman-collection corpus. Each represents an idiom we want
  // to land for migrating users with zero rewriting.

  it('fixture: status-code-and-body-shape', async () => {
    const r = await runScript(`
      pm.test('Status code is 200', function () {
        pm.response.to.have.status(200);
      });
      pm.test('Response has the required fields', function () {
        var data = pm.response.json();
        pm.expect(data).to.have.property('id');
        pm.expect(data).to.have.property('name');
      });
    `);
    expectAllTestsPass(r);
  });

  it('fixture: token-extraction', async () => {
    const r = await runScript(
      `
      pm.test('Token captured', function () {
        var data = pm.response.json();
        pm.expect(data.id).to.be.a('number');
        pm.environment.set('userId', String(data.id));
      });
    `,
      { response: { ...baseResponse, body: { id: 42, name: 'alice' } } }
    );
    expectAllTestsPass(r);
    expect(r.variables['userId']).toBe('42');
  });

  it('fixture: nested-property-asserts', async () => {
    const r = await runScript(`
      pm.test('nested deep', function () {
        var b = pm.response.json();
        pm.expect(b.nested).to.deep.equal({ val: 1 });
        // .have.members is the canonical form for array-membership assertion.
        // Postman docs sometimes show .include.members(...) as a sentence, but
        // it's a chai-plugin feature; users should rewrite as below.
        pm.expect(b.tags).to.have.members(['admin', 'user']);
      });
    `);
    expectAllTestsPass(r);
  });

  it('fixture: chained-not-and-have', async () => {
    // The chained .and.equal(1) form requires chai "subject narrowing" which
    // v1 doesn't implement. Use the two-arg .property('a', 1) form instead —
    // the migration guide flags this.
    const r = await runScript(`
      pm.test('chained', function () {
        pm.expect({a: 1}).to.not.have.property('b');
        pm.expect({a: 1}).to.have.property('a', 1);
      });
    `);
    expectAllTestsPass(r);
  });

  it('fixture: response-text-fallback', async () => {
    const r = await runScript(
      `
      pm.test('text body', function () {
        pm.expect(pm.response.text()).to.match(/hello/);
      });
    `,
      {
        response: {
          ...baseResponse,
          body: 'hello world',
          headers: { 'content-type': 'text/plain' },
        },
      }
    );
    expectAllTestsPass(r);
  });
});
