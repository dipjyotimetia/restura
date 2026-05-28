import { describe, it, expect } from 'vitest';
import ScriptExecutor from '../scriptExecutor';

/**
 * Phase B — `require()` ecosystem coverage.
 *
 * The Vite plugin in `scripts/build-sandbox-libs.mjs` bundles each Postman
 * v12 library into an IIFE source and inlines them into
 * `sandboxLibraries/bundle.generated.ts`. The executor loads that bundle
 * on first `initialize()` and wires `require(name)` against the global
 * each IIFE attaches to.
 *
 * These tests exercise representative APIs from each library to lock in
 * that the bundle integration keeps working after future esbuild upgrades
 * or library version bumps.
 */
async function runScript(script: string) {
  const ex = new ScriptExecutor({});
  return ex.executeScript(script, {});
}

function assertAllPass(result: {
  tests?: Array<{ name: string; passed: boolean; error?: string }>;
}) {
  expect(result.tests).toBeDefined();
  const failed = result.tests!.filter((t) => !t.passed);
  if (failed.length > 0) {
    throw new Error(
      'Failing tests:\n' + failed.map((t) => `  - ${t.name}: ${t.error ?? 'no error'}`).join('\n')
    );
  }
}

describe('require() — Postman library bundle', () => {
  it('require("lodash") — chunk', async () => {
    const r = await runScript(`
      pm.test('chunk', function () {
        var _ = require('lodash');
        pm.expect(_.chunk([1,2,3,4], 2)).to.eql([[1,2],[3,4]]);
      });
    `);
    assertAllPass(r);
  });

  it('require("chai") — provides expect / assert / should', async () => {
    const r = await runScript(`
      pm.test('chai shape', function () {
        var c = require('chai');
        pm.expect(typeof c.expect).to.equal('function');
        pm.expect(typeof c.assert).to.equal('function');
        pm.expect(typeof c.should).to.equal('function');
      });
    `);
    assertAllPass(r);
  });

  it('require("crypto-js") — SHA256 hex length', async () => {
    const r = await runScript(`
      pm.test('sha256', function () {
        var c = require('crypto-js');
        pm.expect(c.SHA256('x').toString().length).to.equal(64);
      });
      pm.test('hmac-sha256', function () {
        var c = require('crypto-js');
        pm.expect(typeof c.HmacSHA256('msg','key').toString()).to.equal('string');
      });
    `);
    assertAllPass(r);
  });

  it('require("moment") — year / add / format', async () => {
    const r = await runScript(`
      pm.test('year', function () {
        var m = require('moment');
        pm.expect(m('2020-01-01').year()).to.equal(2020);
      });
      pm.test('add', function () {
        var m = require('moment');
        pm.expect(m('2020-01-01').add(1, 'day').format('YYYY-MM-DD')).to.equal('2020-01-02');
      });
    `);
    assertAllPass(r);
  });

  it('require("uuid") — v4 produces a 36-char string', async () => {
    const r = await runScript(`
      pm.test('v4 length', function () {
        var u = require('uuid');
        var id = u.v4();
        pm.expect(id.length).to.equal(36);
      });
    `);
    assertAllPass(r);
  });

  it('require("ajv") — validates a numeric schema', async () => {
    const r = await runScript(`
      pm.test('ajv', function () {
        var Ajv = require('ajv');
        var validate = new Ajv().compile({ type: 'number' });
        pm.expect(validate(42)).to.be.true;
        pm.expect(validate('not a number')).to.be.false;
      });
    `);
    assertAllPass(r);
  });

  it('require("tv4") — validates a JSON Schema', async () => {
    const r = await runScript(`
      pm.test('tv4', function () {
        var tv4 = require('tv4');
        pm.expect(tv4.validate({ a: 1 }, { type: 'object', properties: { a: { type: 'number' } } })).to.be.true;
      });
    `);
    assertAllPass(r);
  });

  it('require("cheerio") — parses HTML', async () => {
    const r = await runScript(`
      pm.test('cheerio', function () {
        var $ = require('cheerio').load('<p class="x">hello</p>');
        pm.expect($('p').text()).to.equal('hello');
        pm.expect($('p').hasClass('x')).to.be.true;
      });
    `);
    assertAllPass(r);
  });

  it('require("xml2js") — parseString returns the parsed tree', async () => {
    const r = await runScript(`
      pm.test('xml2js', function () {
        require('xml2js').parseString('<r><c>1</c></r>', function (err, result) {
          pm.expect(err).to.be.null;
          pm.expect(result.r.c[0]).to.equal('1');
        });
      });
    `);
    assertAllPass(r);
  });

  it('require("postman-collection") — Url.parse', async () => {
    const r = await runScript(`
      pm.test('postman-collection Url', function () {
        var pc = require('postman-collection');
        var u = new pc.Url('https://api.example.com/v1/users?id=42');
        pm.expect(u.host.join('.')).to.equal('api.example.com');
        pm.expect(u.path[0]).to.equal('v1');
      });
    `);
    assertAllPass(r);
  });

  it('require("unknown-module") — throws a descriptive error', async () => {
    const r = await runScript(`
      pm.test('unknown', function () {
        try {
          require('nonexistent-pkg');
          pm.expect.fail('should have thrown');
        } catch (e) {
          pm.expect(String(e.message)).to.match(/Cannot find module/);
        }
      });
    `);
    assertAllPass(r);
  });

  it('atob / btoa are top-level globals (Postman v12)', async () => {
    const r = await runScript(`
      pm.test('btoa', function () {
        pm.expect(btoa('hi')).to.equal('aGk=');
      });
      pm.test('atob', function () {
        pm.expect(atob('aGk=')).to.equal('hi');
      });
    `);
    assertAllPass(r);
  });
});
