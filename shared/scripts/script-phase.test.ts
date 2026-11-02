import { describe, expect, it, vi } from 'vitest';
import { NO_SCRIPT_HOST, runScriptPhase, type ScriptPhaseHost } from './script-phase';

const run = (script: string, extra: Partial<Parameters<typeof runScriptPhase>[0]> = {}) =>
  runScriptPhase({
    phase: 'prerequest',
    script,
    envVars: {},
    host: NO_SCRIPT_HOST,
    ...extra,
  });

describe('runScriptPhase — host', () => {
  it('a host with no bridges rejects pm.vault and rs.judge with a clear error', async () => {
    const { result } = await run(
      `pm.vault.get('k').catch((e) => rs.variables.set('vault', e.message));
       rs.judge('x', {}).catch((e) => rs.variables.set('judge', e.message));`,
      { phase: 'test' }
    );
    expect(result.variables.vault).toMatch(/no host adapter wired/);
    expect(result.variables.judge).toMatch(/not wired/);
  });

  // cli/README.md says pm.sendRequest, pm.cookies and pm.vault "reject with a clear
  // error" without a host. pm.vault and rs.judge do; pm.sendRequest and
  // pm.cookies.set are not bound at all, so a call throws "TypeError: not a
  // function". Binding them is a script-executor change (phaseC.test.ts pins
  // pm.sendRequest as undefined), outside this change.
  it.todo(
    'DIVERGENCE: a host with no bridges rejects pm.sendRequest and pm.cookies.set with a clear error (today: TypeError: not a function)'
  );

  it('a host with bridges reaches them (rs.sendRequest)', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      code: 201,
      status: 'Created',
      headers: {},
      body: '{}',
      responseTime: 1,
      responseSize: 2,
    });
    const host: ScriptPhaseHost = { bridges: { sendRequest } };
    const { result } = await run(
      "rs.sendRequest('https://x.test/a', (err, res) => rs.variables.set('code', String(res.code)));",
      { host }
    );
    expect(sendRequest).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://x.test/a' }));
    expect(result.variables.code).toBe('201');
  });

  it('starts from the host globals and hands globals writes back to the host', async () => {
    const applyGlobalsMutations = vi.fn();
    const { result } = await run(
      "rs.variables.set('seen', String(pm.globals.get('g'))); pm.globals.set('g', 'two');",
      { host: { globals: () => ({ g: 'one' }), applyGlobalsMutations } }
    );
    expect(result.variables.seen).toBe('one');
    expect(applyGlobalsMutations).toHaveBeenCalledWith({ g: 'two' });
  });

  it('a host without globals starts empty and drops globals writes', async () => {
    const { result } = await run(
      "rs.variables.set('seen', String(pm.globals.get('g'))); pm.globals.set('g', 'two');"
    );
    expect(result.variables.seen).toBe('undefined');
  });
});

describe('runScriptPhase — scopes and flow', () => {
  it('seeds pm.collectionVariables, pm.iterationData and pm.info from the input', async () => {
    const { result } = await run(
      `rs.variables.set('s', [
        pm.collectionVariables.get('c'),
        pm.iterationData.get('d'),
        pm.info.iteration,
        pm.info.eventName,
        pm.info.requestName,
      ].join('|'));`,
      {
        phase: 'test',
        collectionVars: { c: 'cv' },
        iterationData: { d: 'row' },
        info: { requestName: 'R', iteration: 2 },
      }
    );
    expect(result.variables.s).toBe('cv|row|2|test|R');
  });

  it('reports skipRequest and setNextRequest as flow control', async () => {
    const skipped = await run('pm.execution.skipRequest();');
    expect(skipped.skipRequested).toBe(true);
    const jumped = await run("pm.execution.setNextRequest('B');");
    expect(jumped.skipRequested).toBe(false);
    expect(jumped.outcome.execution?.nextRequest).toBe('B');
  });

  it('reports assertions and errors in the shape the run fold reads', async () => {
    const { outcome } = await run(
      "pm.test('a', () => {}); pm.test('b', () => { throw new Error('no'); });",
      {
        phase: 'test',
      }
    );
    expect(outcome.assertions).toEqual([
      expect.objectContaining({ name: 'a', passed: true }),
      expect.objectContaining({ name: 'b', passed: false }),
    ]);
  });
});

describe('runScriptPhase — absorb', () => {
  it('folds variables and collection writes into the target', async () => {
    const into: Record<string, string> = { keep: '1', drop: '1' };
    await run(
      "rs.variables.set('added', 'x'); pm.collectionVariables.set('c', 'cv'); pm.collectionVariables.unset('drop');",
      { envVars: into, absorb: { into, variables: 'on-success' } }
    );
    expect(into).toEqual({ keep: '1', added: 'x', c: 'cv' });
  });

  it('keeps a failed script out of the target on-success, but not under always', async () => {
    const script = "rs.variables.set('partial', 'x'); throw new Error('boom');";
    const strict: Record<string, string> = {};
    await run(script, { envVars: strict, absorb: { into: strict, variables: 'on-success' } });
    expect(strict).toEqual({});
    const lenient: Record<string, string> = {};
    await run(script, { envVars: lenient, absorb: { into: lenient, variables: 'always' } });
    expect(lenient).toEqual({ partial: 'x' });
  });

  it('does not touch the caller map without absorb', async () => {
    const envVars: Record<string, string> = {};
    await run("rs.variables.set('x', '1');", { envVars });
    expect(envVars).toEqual({});
  });

  it('abandons the phase when afterRun throws, before anything is applied', async () => {
    const into: Record<string, string> = {};
    const applyGlobalsMutations = vi.fn();
    await expect(
      run("rs.variables.set('x', '1'); pm.globals.set('g', '1');", {
        envVars: into,
        absorb: { into, variables: 'always' },
        host: { applyGlobalsMutations },
        afterRun: () => {
          throw new Error('aborted');
        },
      })
    ).rejects.toThrow('aborted');
    expect(into).toEqual({});
    expect(applyGlobalsMutations).not.toHaveBeenCalled();
  });
});
