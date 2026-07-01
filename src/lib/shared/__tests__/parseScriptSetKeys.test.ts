import { describe, expect, it } from 'vitest';
import { parseScriptSetKeys } from '../parseScriptSetKeys';

describe('parseScriptSetKeys', () => {
  it('parses single, double, and backtick quotes', () => {
    expect(parseScriptSetKeys(`pm.environment.set('a', 1)`)).toEqual(['a']);
    expect(parseScriptSetKeys(`pm.environment.set("b", 1)`)).toEqual(['b']);
    expect(parseScriptSetKeys('pm.environment.set(`c`, 1)')).toEqual(['c']);
  });

  it('tolerates interior whitespace', () => {
    expect(parseScriptSetKeys(`pm.variables.set(  "b" , x )`)).toEqual(['b']);
  });

  it('matches both pm.* and rs.* namespaces', () => {
    expect(parseScriptSetKeys(`rs.globals.set('c', 1)`)).toEqual(['c']);
    expect(parseScriptSetKeys(`pm.globals.set('c', 1)`)).toEqual(['c']);
  });

  it('matches all four scopes', () => {
    const src = `
      pm.environment.set('e', 1)
      pm.variables.set('v', 1)
      pm.globals.set('g', 1)
      pm.collectionVariables.set('cv', 1)
    `;
    expect(parseScriptSetKeys(src).sort()).toEqual(['cv', 'e', 'g', 'v']);
  });

  it('skips non-literal (dynamic) keys', () => {
    expect(parseScriptSetKeys(`pm.environment.set(keyVar, x)`)).toEqual([]);
    expect(parseScriptSetKeys('pm.environment.set(`${dyn}`, x)')).toEqual([]);
  });

  it('dedupes repeated keys', () => {
    expect(parseScriptSetKeys(`pm.environment.set('a',1); pm.variables.set('a',2)`)).toEqual(['a']);
  });

  it('ignores unrelated .set( calls', () => {
    expect(parseScriptSetKeys(`const m = new Map(); m.set('x', 1)`)).toEqual([]);
  });

  it('returns [] for empty / undefined input', () => {
    expect(parseScriptSetKeys('')).toEqual([]);
    expect(parseScriptSetKeys(undefined)).toEqual([]);
    expect(parseScriptSetKeys(null)).toEqual([]);
  });
});
