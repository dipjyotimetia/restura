// @vitest-environment node
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRegexRunner,
  handleRegexMessage,
  type RegexRequest,
  type RegexResponse,
  type RegexRunner,
  runRegexRequest,
  validateTimelineRegex,
  type WorkerLike,
} from './timeline-regex';

/**
 * Patterns are assembled from fragments at runtime. They are *data* fed to
 * the validator and to a sandboxed worker — deliberately hostile ones
 * included — not regexes this test runs itself, so keep them out of static
 * regex-literal analysis.
 */
const pat = (...parts: string[]) => parts.join('');

/**
 * Real OS-thread worker running the same message protocol as
 * `timeline-regex.worker.ts`, so budget/terminate behaviour is exercised for
 * real — a catastrophic pattern genuinely spins until terminate().
 */
function nodeWorker(): WorkerLike {
  const w = new Worker(
    `const { parentPort } = require('node:worker_threads');
     parentPort.on('message', (req) => {
       parentPort.postMessage({ id: req.id, started: true });
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

/** A scripted in-process worker for protocol edge cases. */
function fakeWorker(onPost: (req: RegexRequest, reply: (m: RegexResponse) => void) => void) {
  const like: WorkerLike = {
    onmessage: null,
    onerror: null,
    terminate: () => {},
    postMessage: (req) => onPost(req, (data) => like.onmessage?.({ data })),
  };
  return like;
}

/** The five bypasses from the security review of the first heuristic. */
const HOSTILE = [
  pat('((a', '|a))', '*b'),
  pat('\\w+', '\\w+', '\\w+', '\\w+x'),
  pat('.*', '.*', '.*', '.*', '.*x'),
  pat('(a?', 'a?)', '+b'),
  pat('(a+', ')+$'),
];
const CATASTROPHIC = pat('(a+', ')+$');

describe('validateTimelineRegex (fast pre-reject)', () => {
  it('accepts ordinary patterns, including disjoint adjacent quantifiers', () => {
    for (const p of [
      '"orderId":\\s*\\d+', // the panel's placeholder example
      '\\d+\\s*ms',
      'a*b*',
      '\\d+-\\d+',
      '\\s+\\w+',
      'order-\\d+',
      '(foo|bar)\\s',
      '"id":\\d{2}',
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
    expect(validateTimelineRegex(pat('((ab)+', 'c)+'))).toMatch(/nested/i);
    expect(validateTimelineRegex(pat('(x(a|b)', 'y)*'))).toMatch(/alternation/i);
    expect(validateTimelineRegex(pat('(a{1,3}', ')+'))).toMatch(/nested/i);
    expect(validateTimelineRegex(pat('(\\w{2,}', ')*'))).toMatch(/nested/i);
  });

  it('rejects overlapping adjacent unbounded quantifiers, seeing through empty-able atoms', () => {
    expect(validateTimelineRegex(pat('a+?', 'a{2,}'))).toMatch(/adjacent/i);
    expect(validateTimelineRegex(pat('\\d+', '\\s*', '\\d+'))).toMatch(/adjacent/i);
    expect(validateTimelineRegex(pat('\\d+', 'x?', '\\d+'))).toMatch(/adjacent/i);
    expect(validateTimelineRegex(pat('[a-z]+', '[k-q]+'))).toMatch(/adjacent/i);
    expect(validateTimelineRegex(pat('(ab)+', '(cd)*'))).toMatch(/adjacent/i);
    // A mandatory separator breaks adjacency.
    expect(validateTimelineRegex(pat('\\d+', '\\s+', '\\d+'))).toBeNull();
    expect(validateTimelineRegex(pat('\\w+', '|', '\\w+'))).toBeNull();
  });

  it('rejects backreferences, overly long and syntactically invalid patterns', () => {
    expect(validateTimelineRegex(pat('(a)', '\\1'))).toMatch(/backreference/i);
    expect(validateTimelineRegex('a'.repeat(300))).toMatch(/long/i);
    expect(validateTimelineRegex('([')).toMatch(/invalid/i);
  });
});

describe('worker protocol', () => {
  it('runRegexRequest returns one result per text, case-insensitively', () => {
    expect(runRegexRequest({ id: 3, pattern: 'ab', flags: 'i', texts: ['xAB', 'no'] })).toEqual({
      id: 3,
      results: [true, false],
    });
  });

  it('handleRegexMessage acknowledges the start before matching', () => {
    const out: RegexResponse[] = [];
    handleRegexMessage({ id: 1, pattern: 'a', flags: 'i', texts: ['a'] }, (m) => out.push(m));
    expect(out).toEqual([
      { id: 1, started: true },
      { id: 1, results: [true] },
    ]);
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
    // killed at the budget — never a multi-second stall. Slack covers the
    // worker's cold start, which deliberately doesn't count against the budget.
    expect(elapsed).toBeLessThan(budget + 1500);
    if (!result.ok) expect(result.error).toMatch(/took too long/);
  });

  it('a catastrophic pattern is killed and the next search gets a fresh worker', async () => {
    let spawned = 0;
    runner = createRegexRunner(() => {
      spawned += 1;
      return nodeWorker();
    }, 150);
    const slow = await runner.match(CATASTROPHIC, [`${'a'.repeat(40)}!`]);
    expect(slow).toMatchObject({ ok: false, error: expect.stringMatching(/took too long/) });
    expect(await runner.match('a', ['a'])).toEqual({ ok: true, results: [true] });
    expect(spawned).toBe(2);
  });

  it('a new search supersedes the in-flight one', async () => {
    runner = createRegexRunner(nodeWorker, 5000);
    const first = runner.match(CATASTROPHIC, [`${'a'.repeat(40)}!`]);
    const second = runner.match('a', ['a']);
    expect(await first).toMatchObject({ ok: false, cancelled: true });
    expect(await second).toEqual({ ok: true, results: [true] });
  });

  it('worker start-up time does not count against the matching budget', async () => {
    runner = createRegexRunner(
      () =>
        fakeWorker((req, reply) => {
          // Slow cold start (3x the budget), then a fast match.
          setTimeout(() => handleRegexMessage(req, reply), 150);
        }),
      50,
      1000
    );
    expect(await runner.match('a', ['a'])).toEqual({ ok: true, results: [true] });
  });

  it('a worker that never starts times out with a start-up error', async () => {
    runner = createRegexRunner(() => fakeWorker(() => {}), 50, 100);
    expect(await runner.match('a', ['a'])).toEqual({
      ok: false,
      error: 'Regex worker failed to start',
    });
  });

  it('worker construction or postMessage failures resolve with an error', async () => {
    runner = createRegexRunner(() => {
      throw new Error('CSP blocked worker');
    });
    expect(await runner.match('a', ['a'])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/unavailable/),
    });
    runner.dispose();
    runner = createRegexRunner(() =>
      fakeWorker(() => {
        throw new Error('DataCloneError');
      })
    );
    expect(await runner.match('a', ['a'])).toEqual({ ok: false, error: 'Regex search failed' });
  });

  it('reports worker errors and ignores stale responses', async () => {
    let fake: WorkerLike | null = null;
    runner = createRegexRunner(() => {
      fake = fakeWorker(() => {});
      return fake;
    }, 1000);
    const pending = runner.match('a', ['a']);
    fake!.onmessage?.({ data: { id: 999, results: [] } }); // stale id: ignored
    fake!.onerror?.(new Error('boom'));
    expect(await pending).toEqual({ ok: false, error: 'Regex search failed' });
  });
});
