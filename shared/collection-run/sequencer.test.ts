import { describe, expect, it } from 'vitest';
import {
  type DelayPlacement,
  type IterationRow,
  MAX_NEXT_REQUEST_JUMPS,
  pickNextRequest,
  resolveIterationRows,
  type SequenceResult,
  type StepOutcome,
  sequenceCollectionRun,
} from './sequencer';

const OK: StepOutcome = { failed: false, sent: true };
const FAIL: StepOutcome = { failed: true, sent: true };
const SKIP: StepOutcome = { failed: false, sent: false };
const missing = (name: string) =>
  `pm.execution.setNextRequest("${name}"): no runnable with that name`;
const CAP_ERROR = `pm.execution.setNextRequest jump limit (${MAX_NEXT_REQUEST_JUMPS}) exceeded`;

type Script = Record<string, Partial<StepOutcome>>;

interface ScriptedRun {
  items: string[];
  /** Step outcomes by item name, merged over OK. */
  script?: Script;
  rows?: IterationRow[];
  stopOnFailure?: boolean;
  delayMs?: number;
  delayPlacement?: DelayPlacement;
  signal?: AbortSignal;
  /** Runs while the named item's step is in flight. */
  duringStep?: Record<string, () => void>;
}

/**
 * A scripted in-memory host: every call the sequencer makes lands in `trace`,
 * as `start A@0`, `step A@0`, `sleep 5`, `error A@0: msg` or `end@0`.
 */
async function run(input: ScriptedRun): Promise<{ trace: string[]; result: SequenceResult }> {
  const trace: string[] = [];
  const result = await sequenceCollectionRun<string>(
    {
      items: input.items,
      nameOf: (item) => item,
      rows: input.rows ?? [{}],
      stopOnFailure: input.stopOnFailure ?? false,
      delayMs: input.delayMs,
      delayPlacement: input.delayPlacement ?? 'after-sent',
      signal: input.signal,
      sleep: async (ms) => {
        trace.push(`sleep ${ms}`);
      },
    },
    (iteration) => ({
      onStart: (item) => {
        trace.push(`start ${item}@${iteration}`);
      },
      step: async (item) => {
        trace.push(`step ${item}@${iteration}`);
        input.duringStep?.[item]?.();
        return { ...OK, ...input.script?.[item] };
      },
      onFlowError: (item, message) => {
        trace.push(`error ${item}@${iteration}: ${message}`);
      },
      onEnd: () => {
        trace.push(`end@${iteration}`);
      },
    })
  );
  return { trace, result };
}

const stepsOf = (trace: string[]) =>
  trace.filter((line) => line.startsWith('step ')).map((line) => line.slice('step '.length));
const errorsOf = (trace: string[]) => trace.filter((line) => line.startsWith('error '));

describe('sequenceCollectionRun: order of steps', () => {
  const cases: Array<{
    name: string;
    input: ScriptedRun;
    steps: string[];
    errors?: string[];
    bailed?: boolean;
    ends?: number;
  }> = [
    {
      name: 'runs every item once, in order, per row',
      input: { items: ['A', 'B'], rows: [{ r: '1' }, { r: '2' }] },
      steps: ['A@0', 'B@0', 'A@1', 'B@1'],
      ends: 2,
    },
    {
      name: 'jumps forward over items',
      input: { items: ['A', 'B', 'C'], script: { A: { next: 'C' } } },
      steps: ['A@0', 'C@0'],
    },
    {
      name: 'jumps backward',
      input: {
        items: ['A', 'B', 'C'],
        script: { A: { next: 'C' }, C: { next: 'B' }, B: { next: null } },
      },
      steps: ['A@0', 'C@0', 'B@0'],
    },
    {
      name: 'a null next ends only this iteration',
      input: { items: ['A', 'B'], rows: [{}, {}], script: { A: { next: null } } },
      steps: ['A@0', 'A@1'],
      ends: 2,
    },
    {
      name: 'a jump to a missing name reports it and ends only this iteration',
      input: { items: ['A', 'B'], rows: [{}, {}], script: { A: { next: 'Nope' } } },
      steps: ['A@0', 'A@1'],
      errors: [`error A@0: ${missing('Nope')}`, `error A@1: ${missing('Nope')}`],
      ends: 2,
    },
    {
      name: 'a reported bad jump under stopOnFailure reports it, then bails the whole run',
      input: {
        items: ['A', 'B'],
        rows: [{}, {}],
        stopOnFailure: true,
        script: { A: { next: 'Nope' } },
      },
      steps: ['A@0'],
      errors: [`error A@0: ${missing('Nope')}`],
      bailed: true,
      ends: 0,
    },
    {
      name: 'a reported bad jump without stopOnFailure does not bail',
      input: { items: ['A', 'B'], rows: [{}, {}], script: { A: { next: 'Nope' } } },
      steps: ['A@0', 'A@1'],
      errors: [`error A@0: ${missing('Nope')}`, `error A@1: ${missing('Nope')}`],
      bailed: false,
    },
    {
      name: 'an ignored bad jump under stopOnFailure stays silent and does not bail',
      input: {
        items: ['A', 'B'],
        stopOnFailure: true,
        script: { A: { ...SKIP, next: 'Nope', badJump: 'ignore' } },
      },
      steps: ['A@0', 'B@0'],
      errors: [],
      bailed: false,
    },
    {
      name: 'an ignored jump to a missing name advances linearly',
      input: { items: ['A', 'B'], script: { A: { next: 'Nope', badJump: 'ignore' } } },
      steps: ['A@0', 'B@0'],
      errors: [],
    },
    {
      name: 'bail stops the whole run, later data rows included',
      input: { items: ['A', 'B'], rows: [{}, {}], stopOnFailure: true, script: { A: FAIL } },
      steps: ['A@0'],
      bailed: true,
      ends: 0,
    },
    {
      name: 'bail wins over the failed step’s jump',
      input: { items: ['A', 'B'], stopOnFailure: true, script: { A: { ...FAIL, next: 'B' } } },
      steps: ['A@0'],
      bailed: true,
    },
    {
      name: 'a failure without stopOnFailure keeps going',
      input: { items: ['A', 'B'], script: { A: FAIL } },
      steps: ['A@0', 'B@0'],
      bailed: false,
    },
    {
      name: 'a host that reports a skipped item as failed still bails',
      input: {
        items: ['A', 'B'],
        stopOnFailure: true,
        script: { A: { failed: true, sent: false } },
      },
      steps: ['A@0'],
      bailed: true,
    },
    {
      name: 'a host that reports a skipped item as not failed does not bail',
      input: { items: ['A', 'B'], stopOnFailure: true, script: { A: SKIP } },
      steps: ['A@0', 'B@0'],
      bailed: false,
    },
    {
      name: 'a skipped item can still jump',
      input: { items: ['A', 'B', 'C'], script: { A: { ...SKIP, next: 'C' } } },
      steps: ['A@0', 'C@0'],
    },
    {
      name: 'the first of two same-named items wins',
      input: {
        items: ['A', 'Dup', 'B', 'Dup'],
        script: { A: { next: 'Dup' }, Dup: { next: null } },
      },
      steps: ['A@0', 'Dup@0'],
    },
    {
      name: 'a jump to the empty name is unknown',
      input: { items: ['A', ''], script: { A: { next: '' } } },
      steps: ['A@0'],
      errors: [`error A@0: ${missing('')}`],
    },
    {
      name: 'no items still walks each row',
      input: { items: [], rows: [{}, {}] },
      steps: [],
      ends: 2,
    },
    {
      name: 'no rows runs nothing',
      input: { items: ['A'], rows: [] },
      steps: [],
      ends: 0,
    },
  ];

  it.each(cases)('$name', async ({ input, steps, errors, bailed, ends }) => {
    const { trace, result } = await run(input);
    expect(stepsOf(trace)).toEqual(steps);
    if (errors) expect(errorsOf(trace)).toEqual(errors);
    if (bailed !== undefined) expect(result.bailed).toBe(bailed);
    if (ends !== undefined) {
      expect(trace.filter((line) => line.startsWith('end@'))).toHaveLength(ends);
    }
  });
});

describe('sequenceCollectionRun: names inherited from Object.prototype', () => {
  const inherited = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'];

  it.each(inherited)('a jump to %j, which nothing is named, is a missing name', async (name) => {
    const { trace } = await run({ items: ['A', 'B'], script: { A: { next: name } } });
    expect(stepsOf(trace)).toEqual(['A@0']);
    expect(errorsOf(trace)).toEqual([`error A@0: ${missing(name)}`]);
  });

  it.each(inherited)('an ignored jump to %j advances linearly', async (name) => {
    const { trace } = await run({
      items: ['A', 'B'],
      script: { A: { next: name, badJump: 'ignore' } },
    });
    expect(stepsOf(trace)).toEqual(['A@0', 'B@0']);
  });

  it.each(inherited)('an item actually named %j can be jumped to', async (name) => {
    const script: Script = Object.create(null);
    script.A = { next: name };
    const { trace } = await run({ items: ['A', 'B', name], script });
    expect(stepsOf(trace)).toEqual(['A@0', `${name}@0`]);
    expect(errorsOf(trace)).toEqual([]);
  });
});

describe('sequenceCollectionRun: jump cap', () => {
  it('under stopOnFailure the cap error bails the run', async () => {
    const { trace, result } = await run({
      items: ['A'],
      rows: [{}, {}],
      stopOnFailure: true,
      script: { A: { next: 'A' } },
    });
    expect(stepsOf(trace)).toHaveLength(1 + MAX_NEXT_REQUEST_JUMPS);
    expect(errorsOf(trace)).toEqual([`error A@0: ${CAP_ERROR}`]);
    expect(result.bailed).toBe(true);
  });

  it('an ignored cap under stopOnFailure does not bail', async () => {
    const { result } = await run({
      items: ['A'],
      stopOnFailure: true,
      script: { A: { ...SKIP, next: 'A', badJump: 'ignore' } },
    });
    expect(result.bailed).toBe(false);
  });

  it('a self-loop runs the first step plus the cap, then reports, per iteration', async () => {
    const { trace } = await run({ items: ['A', 'B'], script: { A: { next: 'A' } } });
    expect(stepsOf(trace)).toHaveLength(1 + MAX_NEXT_REQUEST_JUMPS);
    expect(errorsOf(trace)).toEqual([`error A@0: ${CAP_ERROR}`]);
    expect(trace.at(-1)).toBe('end@0');
  });

  it('the cap resets for each row', async () => {
    const { trace } = await run({ items: ['A'], rows: [{}, {}], script: { A: { next: 'A' } } });
    expect(stepsOf(trace)).toHaveLength(2 * (1 + MAX_NEXT_REQUEST_JUMPS));
    expect(errorsOf(trace)).toEqual([`error A@0: ${CAP_ERROR}`, `error A@1: ${CAP_ERROR}`]);
  });

  it('an ignored self-loop ends the iteration at the cap without an error', async () => {
    const { trace } = await run({
      items: ['A', 'B'],
      script: { A: { ...SKIP, next: 'A', badJump: 'ignore' } },
    });
    expect(stepsOf(trace)).toHaveLength(1 + MAX_NEXT_REQUEST_JUMPS);
    expect(errorsOf(trace)).toEqual([]);
  });
});

describe('sequenceCollectionRun: abort', () => {
  it('an already-aborted signal runs nothing and calls no iteration end', async () => {
    const controller = new AbortController();
    controller.abort();
    const { trace, result } = await run({
      items: ['A'],
      rows: [{}, {}],
      signal: controller.signal,
    });
    expect(trace).toEqual([]);
    expect(result.bailed).toBe(false);
  });

  it('aborting mid-step stops before the next item, without an iteration end', async () => {
    const controller = new AbortController();
    const { trace } = await run({
      items: ['A', 'B'],
      rows: [{}, {}],
      signal: controller.signal,
      duringStep: { A: () => controller.abort() },
    });
    expect(trace).toEqual(['start A@0', 'step A@0']);
  });

  it('a bad jump from the in-flight step is still reported after an abort', async () => {
    const controller = new AbortController();
    const { trace } = await run({
      items: ['A', 'B'],
      signal: controller.signal,
      script: { A: { next: 'Nope' } },
      duringStep: { A: () => controller.abort() },
    });
    expect(errorsOf(trace)).toEqual([`error A@0: ${missing('Nope')}`]);
  });

  it('aborting during the real timer ends the wait at once', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const result = await sequenceCollectionRun<string>(
      {
        items: ['A', 'B'],
        nameOf: (item) => item,
        rows: [{}],
        stopOnFailure: false,
        delayMs: 60_000,
        delayPlacement: 'after-sent',
        signal: controller.signal,
      },
      () => ({
        onStart: () => undefined,
        step: async () => {
          setTimeout(() => controller.abort(), 5);
          return OK;
        },
        onFlowError: () => undefined,
      })
    );
    expect(result.bailed).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('sequenceCollectionRun: delay placement', () => {
  it('after-sent waits after each sent item, including the last', async () => {
    const { trace } = await run({ items: ['A', 'B'], delayMs: 5 });
    expect(trace).toEqual([
      'start A@0',
      'step A@0',
      'sleep 5',
      'start B@0',
      'step B@0',
      'sleep 5',
      'end@0',
    ]);
  });

  it('after-sent does not wait after a skipped item', async () => {
    const { trace } = await run({ items: ['A', 'B'], delayMs: 5, script: { A: SKIP } });
    expect(trace).toEqual(['start A@0', 'step A@0', 'start B@0', 'step B@0', 'sleep 5', 'end@0']);
  });

  it('after-sent does not wait after a bail', async () => {
    const { trace } = await run({
      items: ['A', 'B'],
      delayMs: 5,
      stopOnFailure: true,
      script: { A: FAIL },
    });
    expect(trace).toEqual(['start A@0', 'step A@0']);
  });

  it('after-sent waits before a follow-up bad jump is reported', async () => {
    const { trace } = await run({ items: ['A'], delayMs: 5, script: { A: { next: 'Nope' } } });
    expect(trace).toEqual([
      'start A@0',
      'step A@0',
      'sleep 5',
      `error A@0: ${missing('Nope')}`,
      'end@0',
    ]);
  });

  it('before-step-once-sent waits between items, after the start hook, not after the last', async () => {
    const { trace } = await run({
      items: ['A', 'B'],
      delayMs: 5,
      delayPlacement: 'before-step-once-sent',
    });
    expect(trace).toEqual(['start A@0', 'step A@0', 'start B@0', 'sleep 5', 'step B@0', 'end@0']);
  });

  it('before-step-once-sent does not wait until something was sent, then waits before skips too', async () => {
    const { trace } = await run({
      items: ['Skip1', 'Sent', 'Skip2'],
      delayMs: 5,
      delayPlacement: 'before-step-once-sent',
      script: { Skip1: SKIP, Skip2: SKIP },
    });
    expect(trace).toEqual([
      'start Skip1@0',
      'step Skip1@0',
      'start Sent@0',
      'step Sent@0',
      'start Skip2@0',
      'sleep 5',
      'step Skip2@0',
      'end@0',
    ]);
  });

  it('before-step-once-sent carries "something was sent" across iterations', async () => {
    const { trace } = await run({
      items: ['A'],
      rows: [{}, {}],
      delayMs: 5,
      delayPlacement: 'before-step-once-sent',
    });
    expect(trace).toEqual([
      'start A@0',
      'step A@0',
      'end@0',
      'start A@1',
      'sleep 5',
      'step A@1',
      'end@1',
    ]);
  });

  it.each(['after-sent', 'before-step-once-sent'] as const)(
    '%s: no delay, no sleep',
    async (delayPlacement) => {
      const { trace } = await run({ items: ['A', 'B'], delayMs: 0, delayPlacement });
      expect(trace.filter((line) => line.startsWith('sleep'))).toEqual([]);
    }
  );
});

describe('resolveIterationRows', () => {
  const row = { k: 'v' };
  it.each([
    { name: 'defaults to one empty row', input: {}, expected: [{}] },
    { name: 'repeats empty rows', input: { repeat: 3 }, expected: [{}, {}, {}] },
    { name: 'floors a fractional repeat', input: { repeat: 2.9 }, expected: [{}, {}] },
    { name: 'runs once for repeat 0', input: { repeat: 0 }, expected: [{}] },
    { name: 'runs once for a negative repeat', input: { repeat: -2 }, expected: [{}] },
    { name: 'runs once for NaN', input: { repeat: Number.NaN }, expected: [{}] },
    { name: 'runs once for Infinity', input: { repeat: Number.POSITIVE_INFINITY }, expected: [{}] },
    { name: 'data rows win over repeat', input: { dataRows: [row], repeat: 3 }, expected: [row] },
    {
      name: 'empty data rows fall back to repeat',
      input: { dataRows: [], repeat: 2 },
      expected: [{}, {}],
    },
    {
      name: 'caps data rows',
      input: { dataRows: [row, row, row], maxIterations: 2 },
      expected: [row, row],
    },
    { name: 'a cap of 0 runs nothing', input: { maxIterations: 0 }, expected: [] },
    {
      name: 'a negative cap is ignored',
      input: { dataRows: [row], maxIterations: -1 },
      expected: [row],
    },
  ])('$name', ({ input, expected }) => {
    expect(resolveIterationRows(input)).toEqual(expected);
  });

  it('gives each repeated iteration its own row object', () => {
    const [first, second] = resolveIterationRows({ repeat: 2 });
    expect(first).not.toBe(second);
  });
});

describe('pickNextRequest', () => {
  it.each([
    { name: 'neither phase', test: undefined, pre: undefined, expected: undefined },
    { name: 'pre-request only', test: undefined, pre: { nextRequest: 'P' }, expected: 'P' },
    { name: 'test wins', test: { nextRequest: 'T' }, pre: { nextRequest: 'P' }, expected: 'T' },
    {
      name: 'test null wins',
      test: { nextRequest: null },
      pre: { nextRequest: 'P' },
      expected: null,
    },
    { name: 'test without the key falls back', test: {}, pre: { nextRequest: 'P' }, expected: 'P' },
    { name: 'pre-request null', test: {}, pre: { nextRequest: null }, expected: null },
  ])('$name', ({ test, pre, expected }) => {
    expect(pickNextRequest(test, pre)).toBe(expected);
  });
});
