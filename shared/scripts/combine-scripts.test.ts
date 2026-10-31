import { describe, expect, it } from 'vitest';
import { combineScripts } from './combine-scripts';
import ScriptExecutor from './script-executor';

describe('combineScripts', () => {
  it('returns undefined for no parts and a single part unchanged', () => {
    expect(combineScripts([undefined, '  '])).toBeUndefined();
    expect(combineScripts([undefined, 'const a = 1;'])).toBe('const a = 1;');
  });

  it('scopes each level so the same const at two levels is not a SyntaxError', async () => {
    const script = combineScripts([
      'const token = "collection"; var shared = token;',
      'const token = "request"; pm.environment.set("t", token + ":" + shared);',
    ]);
    const result = await new ScriptExecutor().executeScript(script ?? '', {});
    expect(result.errors).toEqual([]);
    expect(result.variables.t).toBe('request:collection');
  });
});
