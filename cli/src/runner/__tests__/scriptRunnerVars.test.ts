import { describe, expect, it } from 'vitest';
import type { LoadedRequest } from '../collectionLoader.js';
import { runPreRequestScript, type ScriptRunContext } from '../scriptRunner';

/**
 * The variables a CLI pre-request script leaves for the request it precedes
 * must match the app's (`runScriptPhase` absorb): collection writes take part
 * in substitution, and pm.environment.unset removes the key (pm.variables.unset
 * only clears the script-local value, as in Postman).
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
    url: 'https://x.test/{{token}}',
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

describe('CLI pre-request script variables (app parity)', () => {
  it('a pm.collectionVariables.set is used by the request being sent', async () => {
    const pre = await runPreRequestScript(
      "pm.collectionVariables.set('token', 'abc');",
      item,
      { token: 'OLD' },
      ctx()
    );
    expect(pre.variables.token).toBe('abc');
  });

  it('pm.environment.unset removes the key for this request; pm.variables.unset keeps the env value', async () => {
    const pre = await runPreRequestScript(
      "pm.environment.unset('token'); pm.variables.unset('other');",
      item,
      { token: 'OLD', other: 'O', keep: 'K' },
      ctx()
    );
    expect(pre.variables).toEqual({ other: 'O', keep: 'K' });
  });

  it('pm.sendRequest is defined in the CLI and rejects with a clear error', async () => {
    const pre = await runPreRequestScript(
      "pm.sendRequest('https://x.test/a', function (err) { pm.variables.set('e', err.message); });",
      item,
      {},
      ctx()
    );
    expect(pre.errors).toEqual([]);
    expect(pre.variables.e).toMatch(/not available in this host/);
  });
});
