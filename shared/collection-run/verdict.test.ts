import { describe, expect, it } from 'vitest';
import { foldScriptPhases, type PhaseOutcome, settleVerdict, skipVerdict } from './verdict';

const pass = (name: string) => ({ name, passed: true });
const fail = (name: string, error = 'nope') => ({ name, passed: false, error });

const pre = (outcome?: PhaseOutcome, thrown?: string) => ({
  label: 'pre-request',
  outcome,
  thrown,
});
const test = (outcome?: PhaseOutcome, thrown?: string) => ({ label: 'test', outcome, thrown });

describe('foldScriptPhases', () => {
  it('collects assertions in phase order', () => {
    const fold = foldScriptPhases(
      [pre({ assertions: [pass('a')] }), test({ assertions: [fail('b'), pass('c')] })],
      { labelErrors: false }
    );
    expect(fold.assertions.map((a) => a.name)).toEqual(['a', 'b', 'c']);
  });

  it('joins errors flat when not labelled, dropping empty ones', () => {
    const fold = foldScriptPhases([pre({ errors: ['x', ''] }), test({ errors: ['y'] })], {
      labelErrors: false,
    });
    expect(fold.errors).toEqual(['x', 'y']);
    expect(fold.errorText).toBe('x; y');
  });

  it('labels each failing phase when asked, and a thrown phase has no outcome', () => {
    const fold = foldScriptPhases(
      [pre({ errors: ['a', 'b'], assertions: [pass('kept')] }), test(undefined, 'boom')],
      { labelErrors: true }
    );
    expect(fold.errorText).toBe('pre-request: a; b; test: boom');
    expect(fold.assertions.map((a) => a.name)).toEqual(['kept']);
  });

  it('reports no error text when nothing failed', () => {
    const fold = foldScriptPhases([pre(), test({ assertions: [pass('a')] })], {
      labelErrors: true,
    });
    expect(fold.errorText).toBeUndefined();
  });
});

describe('skipVerdict', () => {
  const fold = (o: PhaseOutcome) => foldScriptPhases([pre(o)], { labelErrors: true });
  it('passes unless a script errored or an assertion failed', () => {
    expect(skipVerdict(fold({})).passed).toBe(true);
    expect(skipVerdict(fold({ assertions: [pass('a')] })).passed).toBe(true);
    expect(skipVerdict(fold({ assertions: [fail('a')] })).passed).toBe(false);
    expect(skipVerdict(fold({ errors: ['e'] })).passed).toBe(false);
  });
});

describe('settleVerdict', () => {
  const fold = (pre_?: PhaseOutcome, test_?: PhaseOutcome, labelErrors = false) =>
    foldScriptPhases([pre(pre_), test(test_)], { labelErrors });

  it('takes the protocol verdict when nothing was asserted', () => {
    expect(settleVerdict({ protocolPassed: true, fold: fold(), errorStyle: 'append' })).toEqual({
      passed: true,
    });
    expect(
      settleVerdict({
        protocolPassed: false,
        protocolError: 'rpc error',
        fold: fold(),
        errorStyle: 'append',
      })
    ).toEqual({ passed: false, error: 'rpc error' });
  });

  it('lets assertions override the protocol verdict, and hides its reason', () => {
    expect(
      settleVerdict({
        protocolPassed: false,
        protocolError: 'rpc error',
        fold: fold(undefined, { assertions: [pass('a')] }),
        errorStyle: 'append',
      })
    ).toEqual({ passed: true });
    expect(
      settleVerdict({
        protocolPassed: true,
        fold: fold(undefined, { assertions: [pass('a'), fail('b')] }),
        errorStyle: 'append',
      }).passed
    ).toBe(false);
  });

  it('a script error always fails the step', () => {
    expect(
      settleVerdict({
        protocolPassed: true,
        fold: fold({ errors: ['bad'], assertions: [pass('a')] }),
        errorStyle: 'append',
      })
    ).toEqual({ passed: false, error: 'bad' });
  });

  it('a transport error always fails the step, even with a passing assertion', () => {
    expect(
      settleVerdict({
        protocolPassed: true,
        transportError: 'ECONNREFUSED',
        fold: fold(undefined, { assertions: [pass('a')] }),
        errorStyle: 'append',
      })
    ).toEqual({ passed: false, error: 'ECONNREFUSED' });
  });

  it('append keeps the failure reason and the script errors; script-wins keeps the script errors', () => {
    const input = {
      protocolPassed: false,
      protocolError: 'rpc error',
      fold: fold({ errors: ['bad'] }),
    } as const;
    expect(settleVerdict({ ...input, errorStyle: 'append' }).error).toBe('rpc error; bad');
    expect(settleVerdict({ ...input, errorStyle: 'script-wins' }).error).toBe('bad');
  });

  it('reports a protocol reason only for a step that failed', () => {
    expect(
      settleVerdict({
        protocolPassed: true,
        protocolError: 'should not show',
        fold: fold(),
        errorStyle: 'append',
      })
    ).toEqual({ passed: true });
  });
});
