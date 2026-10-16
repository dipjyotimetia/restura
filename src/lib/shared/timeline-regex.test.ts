// @vitest-environment node
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRegexRunner,
  type RegexRequest,
  type RegexRunner,
  runRegexRequest,
  validateTimelineRegex,
  type WorkerLike,
} from './timeline-regex';

/**
 * Real OS-thread worker running the same body as `timeline-regex.worker.ts`
 * (`runRegexRequest`), so budget/terminate behaviour is exercised for real —
 * a catastrophic pattern genuinely spins until terminate().
 */
function nodeWorker(): WorkerLike {
  const w = new Worker(
    `const { parentPort } = require('node:worker_threads');
     parentPort.on('message', (req) => {
       const re = new RegExp(req.pattern, req.flags);
       parentPort.postMessage({ id: req.id, results: req.texts.map((t) => re.test(t)) });
     });`,
    { eval: true }
  );
  const like: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (m: RegexRequest) => w.postMessage(m),
    terminate: () => {
      void w.terminate();
    },
  };
  w.on('message', (data) => like.onmessage?.({ data }));
  w.on('error', (err) => like.onerror?.(err));
  return like;
}

/** The five bypasses from the security review of the first heuristic. */
const HOSTILE = ['((a|a))*b', '\\w+\\w+\\w+\\w+x', '.*.*.*.*.*x', '(a?a?)+b', '(a+)+$'];

describe('validateTimelineRegex (fast pre-reject)', () => {
  it('accepts ordinary patterns', () => {
    for (const p of [
      'order-\\d+',
      '(foo|bar)\\s',
      '"id":\\d{2}',
      '\\d+-\\d+',
      '[(+*]+ok',
      '((ab)c)+',
      '^broker',
      '(?:ab)+c',
      '(?<word>x)y',
      '(?<=a)b',
      'a{2,3}b{4}',
    ]) {
      expect(validateTimelineRegex(p), p).toBeNull();
    }
  });

  it('rejects every reviewed bypass shape', () => {
    for (const p of HOSTILE) expect(validateTimelineRegex(p), p).toMatch(/rejected/i);
  });

  it('propagates inner quantifiers/alternations to outer groups and counts ? and {n,m}', () => {
    expect(validateTimelineRegex('((ab)+c)+')).toMatch(/nested/i);
    expect(validateTimelineRegex('(x(a|b)y)*')).toMatch(/alternation/i);
    expect(validateTimelineRegex('(a{1,3})+')).toMatch(/nested/i);
    expect(validateTimelineRegex('(\\w{2,})*')).toMatch(/nested/i);
    expect(validateTimelineRegex('a+?b{2,}')).toMatch(/adjacent/i);
    expect(validateTimelineRegex('(ab)+(cd)*')).toMatch(/adjacent/i);
  });

  it('rejects backreferences, overly long and syntactically invalid patterns', () => {
    expect(validateTimelineRegex('(a)\\1')).toMatch(/backreference/i);
    expect(validateTimelineRegex('a'.repeat(300))).toMatch(/long/i);
    expect(validateTimelineRegex('([')).toMatch(/invalid/i);
  });
});

describe('runRegexRequest', () => {
  it('returns one result per text, case-insensitively', () => {
    expect(runRegexRequest({ id: 3, pattern: 'ab', flags: 'i', texts: ['xAB', 'no'] })).toEqual({
      id: 3,
      results: [true, false],
    });
  });
});

describe('createRegexRunner', () => {
  let runner: RegexRunner | null = null;
  afterEach(() => {
    runner?.dispose();
    runner = null;
  });

  it('matches in the worker and reuses it across searches', async () => {
    let spawned = 0;
    runner = createRegexRunner(() => {
      spawned += 1;
      return nodeWorker();
    }, 2000);
    expect(await runner.match('"n":1\\d', ['{"n":12}', '{"n":2}'])).toEqual({
      ok: true,
      results: [true, false],
    });
    expect(await runner.match('^x', ['xy'])).toEqual({ ok: true, results: [true] });
    expect(spawned).toBe(1);
  });

  it.each(HOSTILE)('time-boxes %s against a 16 KB event', async (pattern) => {
    const budget = 250;
    runner = createRegexRunner(nodeWorker, budget);
    const hostile = 'a'.repeat(16 * 1024);
    const started = performance.now();
    const result = await runner.match(pattern, [hostile]);
    const elapsed = performance.now() - started;
    // Either the worker finished (non-catastrophic for this input) or it was
    // killed at the budget — never a multi-second stall.
    expect(elapsed).toBeLessThan(budget + 750);
    if (!result.ok) expect(result.error).toMatch(/took too long/);
  });

  it('a catastrophic pattern is killed and the next search gets a fresh worker', async () => {
    let spawned = 0;
    runner = createRegexRunner(() => {
      spawned += 1;
      return nodeWorker();
    }, 150);
    const slow = await runner.match('(a+)+$', [`${'a'.repeat(40)}!`]);
    expect(slow).toMatchObject({ ok: false, error: expect.stringMatching(/took too long/) });
    expect(await runner.match('a', ['a'])).toEqual({ ok: true, results: [true] });
    expect(spawned).toBe(2);
  });

  it('a new search supersedes the in-flight one', async () => {
    runner = createRegexRunner(nodeWorker, 5000);
    const first = runner.match('(a+)+$', [`${'a'.repeat(40)}!`]);
    const second = runner.match('a', ['a']);
    expect(await first).toMatchObject({ ok: false, cancelled: true });
    expect(await second).toEqual({ ok: true, results: [true] });
  });

  it('reports worker errors and ignores stale responses', async () => {
    let fake: WorkerLike | null = null;
    runner = createRegexRunner(() => {
      fake = {
        onmessage: null,
        onerror: null,
        postMessage: () => {},
        terminate: () => {},
      };
      return fake;
    }, 1000);
    const pending = runner.match('a', ['a']);
    fake!.onmessage?.({ data: { id: 999, results: [] } }); // stale id: ignored
    fake!.onerror?.(new Error('boom'));
    expect(await pending).toEqual({ ok: false, error: 'Regex search failed' });
  });
});
