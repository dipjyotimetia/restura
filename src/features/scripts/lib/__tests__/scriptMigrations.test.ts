import { describe, it, expect } from 'vitest';
import { migrateScriptPmToRs, migrateScriptRsToPm } from '../scriptMigrations';

describe('migrateScriptPmToRs', () => {
  it('rewrites every top-level pm.* namespace reference to rs.*', () => {
    const src = [
      'pm.test("ok", () => {',
      '  pm.expect(pm.response.status).to.equal(200);',
      '  pm.variables.set("id", pm.response.json().data.id);',
      '});',
      'pm.globals.unset("tmp");',
      'pm.collectionVariables.get("base");',
      'pm.environment.set("k", "v");',
      'pm.execution.setNextRequest("next");',
      'pm.cookies.get("sid");',
      'await pm.vault.get("secret");',
      'await pm.sendRequest("https://x");',
      'pm.visualizer.set("<b>{{x}}</b>", {});',
      'pm.info.requestName;',
      'pm.iterationData.get("row");',
    ].join('\n');
    const out = migrateScriptPmToRs(src);
    expect(out).not.toMatch(/\bpm\./);
    expect(out).toContain('rs.test("ok"');
    expect(out).toContain('rs.expect(rs.response.status)');
    expect(out).toContain('rs.sendRequest("https://x")');
    expect(out).toContain('rs.vault.get("secret")');
  });

  it('does not touch identifiers that merely end in pm', () => {
    const src = 'npm.install(); spm.foo(); const tempm = 1; tempm.bar();';
    expect(migrateScriptPmToRs(src)).toBe(src);
  });

  it('does not touch pm as a non-top-level member', () => {
    const src = 'config.pm.timeout = 5; obj.pm.test();';
    expect(migrateScriptPmToRs(src)).toBe(src);
  });

  it('does not rewrite pm. inside string literals', () => {
    const src = 'rs.variables.set("url", "https://pm.example.com/pm.json");';
    const out = migrateScriptPmToRs(src);
    expect(out).toContain('"https://pm.example.com/pm.json"');
  });

  it('does not rewrite pm. inside line comments', () => {
    const src = '// legacy pm.test usage\npm.test("x", () => {});';
    const out = migrateScriptPmToRs(src);
    expect(out).toContain('// legacy pm.test usage');
    expect(out).toContain('rs.test("x"');
  });

  it('does not rewrite pm. inside block comments but does rewrite the code', () => {
    const src = 'pm.test(/* keep pm.foo here */ "x", () => {});';
    const out = migrateScriptPmToRs(src);
    expect(out).toContain('/* keep pm.foo here */');
    expect(out).toContain('rs.test(');
  });

  it('does not corrupt pm. inside a regex literal', () => {
    const src = 'const re = /pm\\.test/; rs.expect(re.test("pm.test")).to.be.true;';
    const out = migrateScriptPmToRs(src);
    expect(out).toContain('/pm\\.test/');
  });

  it('still migrates pm. that follows a division operator', () => {
    const src = 'const r = total / pm.variables.get("count");';
    const out = migrateScriptPmToRs(src);
    expect(out).toBe('const r = total / rs.variables.get("count");');
  });

  it('does not rewrite pm. inside a template-literal interpolation (documented limitation)', () => {
    const src = 'const u = `${pm.variables.get("base")}/api`;';
    const out = migrateScriptPmToRs(src);
    expect(out).toContain('${pm.variables.get("base")}');
  });

  it('handles all three quote types in one script', () => {
    const src = `pm.test('single'); pm.variables.set("double"); pm.variables.get(\`tick\`);`;
    const out = migrateScriptPmToRs(src);
    expect(out).toContain("rs.test('single')");
    expect(out).toContain('rs.variables.set("double")');
    expect(out).toContain('rs.variables.get(`tick`)');
  });

  it('migrates remaining pm.* while leaving existing rs.* untouched (mixed source)', () => {
    const src = 'pm.test("x", () => { rs.variables.get("y"); pm.expect(1).to.equal(1); });';
    const out = migrateScriptPmToRs(src);
    expect(out).not.toMatch(/\bpm\./);
    expect(out).toContain('rs.variables.get("y")');
    expect(out).toContain('rs.expect(1)');
  });

  it('preserves numeric literals (sentinel masking does not clobber numbers)', () => {
    const src = 'pm.expect(pm.response.status).to.equal(200);\nconst ms = 1000;';
    const out = migrateScriptPmToRs(src);
    expect(out).toContain('to.equal(200)');
    expect(out).toContain('const ms = 1000;');
  });

  it('handles whitespace between identifier and dot', () => {
    expect(migrateScriptPmToRs('pm . test()')).toBe('rs . test()');
  });

  it('is idempotent', () => {
    const src = 'pm.test("x", () => pm.expect(1).to.equal(1));';
    const once = migrateScriptPmToRs(src);
    expect(migrateScriptPmToRs(once)).toBe(once);
  });

  it('returns empty/undefined-equivalent inputs unchanged', () => {
    expect(migrateScriptPmToRs('')).toBe('');
  });
});

describe('migrateScriptRsToPm', () => {
  it('reverses rs.* back to pm.* for Postman export', () => {
    const src = 'rs.test("x", () => rs.expect(rs.response.status).to.equal(200));';
    expect(migrateScriptRsToPm(src)).toBe(
      'pm.test("x", () => pm.expect(pm.response.status).to.equal(200));'
    );
  });

  it('does not touch string content on reverse', () => {
    const src = 'rs.variables.set("k", "rs.value-literal");';
    expect(migrateScriptRsToPm(src)).toContain('"rs.value-literal"');
  });
});

describe('round-trip', () => {
  it('pm -> rs -> pm equals the original for code-context references', () => {
    const original = [
      'pm.test("Status is 200", function () {',
      '  pm.expect(pm.response.status).to.equal(200);',
      '  const body = pm.response.json();',
      '  pm.variables.set("token", body.token);',
      '});',
    ].join('\n');
    expect(migrateScriptRsToPm(migrateScriptPmToRs(original))).toBe(original);
  });
});
