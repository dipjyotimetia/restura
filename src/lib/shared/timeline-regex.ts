/**
 * Regex search for the streaming timeline (issue #971).
 *
 * JavaScript regexes backtrack, and no static check can prove a pattern runs
 * in linear time. So safety comes from *where* matching runs, not from the
 * pattern check: matching happens in a Web Worker with a wall-clock budget,
 * and a worker that overruns is terminate()d. `validateTimelineRegex` is only
 * a fast pre-filter that rejects well-known catastrophic shapes up front with
 * a helpful message; patterns it lets through can still be slow and are
 * caught by the budget.
 */

export const MAX_REGEX_LENGTH = 256;
/** Wall-clock budget for one regex search across every pending event. */
export const REGEX_BUDGET_MS = 250;
export const REGEX_FLAGS = 'i';

interface Frame {
  quantified: boolean;
  alternation: boolean;
  /** The previous atom at this level carried an unbounded quantifier. */
  prevUnbounded: boolean;
}

const newFrame = (): Frame => ({ quantified: false, alternation: false, prevUnbounded: false });

/** Length and boundedness of the quantifier at `i`, or null when there is none. */
function readQuantifier(p: string, i: number): { len: number; unbounded: boolean } | null {
  const ch = p[i];
  let len = 0;
  let unbounded = false;
  if (ch === '*' || ch === '+') {
    len = 1;
    unbounded = true;
  } else if (ch === '?') {
    len = 1;
  } else if (ch === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i));
    if (!m) return null;
    len = m[0].length;
    unbounded = m[2] !== undefined && m[3] === '';
  } else {
    return null;
  }
  if (p[i + len] === '?') len += 1; // lazy modifier
  return { len, unbounded };
}

/** Index just past a `[...]` class starting at `i`. */
function skipClass(p: string, i: number): number {
  let j = i + 1;
  while (j < p.length && p[j] !== ']') j += p[j] === '\\' ? 2 : 1;
  return j + 1;
}

/** Index just past a group opener `(`, `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<name>`. */
function skipGroupOpen(p: string, i: number): number {
  if (p[i + 1] !== '?') return i + 1;
  const kind = p[i + 2];
  if (kind === '<' && p[i + 3] !== '=' && p[i + 3] !== '!') return p.indexOf('>', i) + 1;
  return i + (kind === '<' ? 4 : 3);
}

/**
 * Fast pre-reject for patterns with known catastrophic-backtracking shapes.
 * Not a safety guarantee — the worker budget is. Rejects:
 * - over-long patterns and backreferences;
 * - a quantified group whose body (at any depth) contains a quantifier
 *   (`*`, `+`, `?`, `{n,m}`) or an alternation — `(a+)+`, `(a?a?)+`, `((a|a))*`;
 * - two adjacent unboundedly-quantified atoms — `\w+\w+`, `.*.*`.
 */
export function validateTimelineRegex(pattern: string): string | null {
  if (pattern.length > MAX_REGEX_LENGTH) {
    return `Pattern too long (max ${MAX_REGEX_LENGTH} characters)`;
  }
  if (/\\[1-9]|\\k</.test(pattern)) return 'Backreferences are not supported';
  try {
    new RegExp(pattern, REGEX_FLAGS);
  } catch (err) {
    return `Invalid regex: ${String(err)}`;
  }
  const stack: Frame[] = [newFrame()];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    const top = stack[stack.length - 1]!;
    let group: Frame | null = null;
    if (ch === '(') {
      stack.push(newFrame());
      i = skipGroupOpen(pattern, i);
      continue;
    }
    if (ch === '|') {
      top.alternation = true;
      top.prevUnbounded = false;
      i += 1;
      continue;
    }
    if (ch === '^' || ch === '$') {
      top.prevUnbounded = false;
      i += 1;
      continue;
    }
    if (ch === ')') {
      group = stack.pop()!;
      i += 1;
    } else if (ch === '\\') {
      i += 2;
    } else if (ch === '[') {
      i = skipClass(pattern, i);
    } else {
      i += 1;
    }
    // `parent` is the frame the atom just read belongs to.
    const parent = stack[stack.length - 1]!;
    const q = readQuantifier(pattern, i);
    if (q) {
      i += q.len;
      if (group && (group.quantified || group.alternation)) {
        return group.quantified
          ? 'Nested quantifiers are rejected (catastrophic backtracking) — simplify the pattern'
          : 'Quantified alternation is rejected (catastrophic backtracking) — simplify the pattern';
      }
      if (q.unbounded && parent.prevUnbounded) {
        return 'Adjacent unbounded quantifiers are rejected (polynomial backtracking) — simplify the pattern';
      }
      parent.quantified = true;
      parent.prevUnbounded = q.unbounded;
    } else {
      parent.prevUnbounded = false;
    }
    // Inner quantifiers/alternations stay visible to every enclosing group.
    if (group) {
      if (group.quantified) parent.quantified = true;
      if (group.alternation) parent.alternation = true;
    }
  }
  return null;
}

// --- Worker-backed matching --------------------------------------------------

export interface RegexRequest {
  id: number;
  pattern: string;
  flags: string;
  texts: string[];
}

export interface RegexResponse {
  id: number;
  results: boolean[];
}

/** Pure worker body: one boolean per input text. */
export function runRegexRequest(req: RegexRequest): RegexResponse {
  const re = new RegExp(req.pattern, req.flags);
  return { id: req.id, results: req.texts.map((t) => re.test(t)) };
}

/** The slice of the DOM `Worker` API the runner needs (lets tests plug in node workers). */
export interface WorkerLike {
  postMessage(message: RegexRequest): void;
  terminate(): void;
  onmessage: ((event: { data: RegexResponse }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type RegexMatchResult =
  | { ok: true; results: boolean[] }
  | { ok: false; error: string; cancelled?: boolean };

export interface RegexRunner {
  match(pattern: string, texts: string[]): Promise<RegexMatchResult>;
  dispose(): void;
}

/**
 * One reusable worker; a request that overruns `budgetMs` terminates it (the
 * next request spawns a fresh one). A new request supersedes an in-flight one.
 */
export function createRegexRunner(
  createWorker: () => WorkerLike,
  budgetMs: number = REGEX_BUDGET_MS
): RegexRunner {
  let worker: WorkerLike | null = null;
  let nextId = 0;
  let inflight: {
    id: number;
    timer: ReturnType<typeof setTimeout>;
    resolve: (r: RegexMatchResult) => void;
  } | null = null;

  const settle = (result: RegexMatchResult, kill: boolean) => {
    if (!inflight) return;
    clearTimeout(inflight.timer);
    const { resolve } = inflight;
    inflight = null;
    if (kill && worker) {
      worker.terminate();
      worker = null;
    }
    resolve(result);
  };

  const ensureWorker = (): WorkerLike => {
    if (worker) return worker;
    const w = createWorker();
    w.onmessage = (event) => {
      if (inflight && event.data.id === inflight.id) {
        settle({ ok: true, results: event.data.results }, false);
      }
    };
    w.onerror = () => settle({ ok: false, error: 'Regex search failed' }, true);
    worker = w;
    return w;
  };

  return {
    match(pattern, texts) {
      settle({ ok: false, error: 'Superseded', cancelled: true }, true);
      const id = ++nextId;
      return new Promise<RegexMatchResult>((resolve) => {
        const w = ensureWorker();
        const timer = setTimeout(
          () =>
            settle(
              { ok: false, error: `Regex took too long (>${budgetMs} ms) — simplify the pattern` },
              true
            ),
          budgetMs
        );
        inflight = { id, timer, resolve };
        w.postMessage({ id, pattern, flags: REGEX_FLAGS, texts });
      });
    },
    dispose() {
      settle({ ok: false, error: 'Disposed', cancelled: true }, true);
      worker?.terminate();
      worker = null;
    },
  };
}
