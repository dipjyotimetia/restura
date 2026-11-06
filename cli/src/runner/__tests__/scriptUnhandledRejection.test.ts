import ScriptExecutor from '@shared/scripts/script-executor';
import { describe, expect, it } from 'vitest';
import type { LoadedRequest } from '../collectionLoader.js';
import { runPreRequestScript, runTestScript, type ScriptRunContext } from '../scriptRunner';

/**
 * A rejection a script drops mid-script is a script error in the CLI exactly
 * as in the app (both run the shared executor).
 */

const item = {
  type: 'http',
  relativePath: 'r.http.yaml',
  folderPath: [],
  request: {
    id: 'r',
    name: 'R',
    type: 'http',
    method: 'GET',
    url: 'https://x.test/',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  },
} as unknown as LoadedRequest;

const ctx = (): ScriptRunContext => ({
  collectionVars: {},
  iterationData: {},
  iteration: 0,
  iterationCount: 1,
});

const SCRIPT =
  "Promise.resolve(1).then(function () { throw new Error('dropped'); }); console.log('after');";

describe('CLI unhandled promise rejections (app parity)', () => {
  it('a pre-request script reports the same error the app does', async () => {
    const app = await new ScriptExecutor().executeScript(SCRIPT, {});
    const pre = await runPreRequestScript(SCRIPT, item, {}, ctx());
    expect(pre.errors).toHaveLength(1);
    expect(pre.errors[0]).toMatch(/^Unhandled promise rejection: .*dropped/);
    expect(pre.errors).toEqual(app.errors);
  });

  it('a test script reports it too', async () => {
    const post = await runTestScript(
      "Promise.reject('late'); pm.test('ok', function () {});",
      item,
      { status: 200, durationMs: 1, bodyBytes: 0 } as never,
      {},
      ctx()
    );
    expect(post.errors).toEqual(['Unhandled promise rejection: late']);
    expect(post.assertions).toEqual([{ name: 'ok', passed: true }]);
  });

  it('a dropped pm.sendRequest (no sub-request path in the CLI) is reported', async () => {
    const pre = await runPreRequestScript("pm.sendRequest('https://x.test/a'); 1", item, {}, ctx());
    expect(pre.errors.join('\n')).toMatch(/Unhandled promise rejection: .*not available/);
  });
});
