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
  /**
   * ASCII characters (bitmask) that the trailing run of unbounded, possibly
   * empty-adjacent atoms at this level can consume. A new unbounded atom that
   * overlaps it can split the same input many ways — `\w+\w+`, `.*.*`.
   */
  run: bigint;
}

const ASCII_ALL = (BigInt(1) << BigInt(128)) - BigInt(1);
const NONE = BigInt(0);

const newFrame = (): Frame => ({ quantified: false, alternation: false, run: NONE });

interface Quantifier {
  len: number;
  min: number;
  unbounded: boolean;
}

/** The quantifier at `i`, or null when there is none. */
function readQuantifier(p: string, i: number): Quantifier | null {
  const ch = p[i];
  let q: Quantifier;
  if (ch === '*') q = { len: 1, min: 0, unbounded: true };
  else if (ch === '+') q = { len: 1, min: 1, unbounded: true };
  else if (ch === '?') q = { len: 1, min: 0, unbounded: false };
  else if (ch === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i));
    if (!m) return null;
    q = { len: m[0].length, min: Number(m[1]), unbounded: m[2] !== undefined && m[3] === '' };
  } else {
    return null;
  }
  if (p[i + q.len] === '?') q.len += 1; // lazy modifier
  return q;
}

const maskCache = new Map<string, bigint>();

/**
 * Which ASCII characters a single-character atom (literal, escape, class or
 * `.`) can match, as a bitmask. Probing 128 one-char strings against a
 * one-atom regex is linear and cheap. Unknown shapes count as "anything".
 */
function atomMask(source: string): bigint {
  const cached = maskCache.get(source);
  if (cached !== undefined) return cached;
  let mask = NONE;
  try {
    const re = new RegExp(`^(?:${source})$`, REGEX_FLAGS);
    for (let c = 0; c < 128; c++) {
      if (re.test(String.fromCharCode(c))) mask |= BigInt(1) << BigInt(c);
    }
  } catch {
    mask = ASCII_ALL;
  }
  maskCache.set(source, mask);
  return mask;
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
 * Not a safety guarantee — the worker budget is — so it errs towards letting
 * patterns through. Rejects:
 * - over-long patterns and backreferences;
 * - a quantified group whose body (at any depth) contains a quantifier
 *   (`*`, `+`, `?`, `{n,m}`) or an alternation — `(a+)+`, `(a?a?)+`, `((a|a))*`;
 * - adjacent unbounded quantifiers whose atoms can match the same character
 *   — `\w+\w+`, `.*.*`, `\d+\s*\d+`. Disjoint runs such as `\s*\d+` pass.
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
    if (ch === '|' || ch === '^' || ch === '$') {
      if (ch === '|') top.alternation = true;
      top.run = NONE;
      i += 1;
      continue;
    }
    const start = i;
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
      parent.quantified = true;
      if (q.unbounded) {
        const mask = group ? ASCII_ALL : atomMask(pattern.slice(start, i - q.len));
        if ((parent.run & mask) !== NONE) {
          return 'Overlapping adjacent unbounded quantifiers are rejected (polynomial backtracking) — simplify the pattern';
        }
        // A possibly-empty atom (`*`, `{0,}`) keeps earlier atoms adjacent to later ones.
        parent.run = q.min === 0 ? parent.run | mask : mask;
      } else if (q.min > 0) {
        parent.run = NONE;
      }
      // `?` / `{0,n}` can match nothing, so the run stays adjacent across it.
    } else {
      parent.run = NONE;
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

/** How long a (cold) worker may take to load and receive the batch before we give up. */
export const REGEX_STARTUP_MS = 5000;

export interface RegexRequest {
  id: number;
  pattern: string;
  flags: string;
  texts: string[];
}

/**
 * Worker → runner messages. `started` is posted right before matching begins,
 * so worker load time and structured-cloning the batch don't count against
 * the matching budget.
 */
export type RegexResponse = { id: number; started: true } | { id: number; results: boolean[] };

/** Pure worker body: one boolean per input text. */
export function runRegexRequest(req: RegexRequest): { id: number; results: boolean[] } {
  const re = new RegExp(req.pattern, req.flags);
  return { id: req.id, results: req.texts.map((t) => re.test(t)) };
}

/** Message handler shared by the real worker and test workers. */
export function handleRegexMessage(req: RegexRequest, post: (msg: RegexResponse) => void): void {
  post({ id: req.id, started: true });
  post(runRegexRequest(req));
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
 * One reusable worker. The matching budget starts when the worker reports it
 * has begun matching; a request that overruns it terminates the worker (the
 * next request spawns a fresh one). A new request supersedes an in-flight one.
 */
export function createRegexRunner(
  createWorker: () => WorkerLike,
  budgetMs: number = REGEX_BUDGET_MS,
  startupMs: number = REGEX_STARTUP_MS
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

  const tooLong = () =>
    settle(
      { ok: false, error: `Regex took too long (>${budgetMs} ms) — simplify the pattern` },
      true
    );

  const ensureWorker = (): WorkerLike => {
    if (worker) return worker;
    const w = createWorker();
    w.onmessage = (event) => {
      const data = event.data;
      if (!inflight || data.id !== inflight.id) return;
      if ('started' in data) {
        clearTimeout(inflight.timer);
        inflight.timer = setTimeout(tooLong, budgetMs);
        return;
      }
      settle({ ok: true, results: data.results }, false);
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
        let w: WorkerLike;
        try {
          w = ensureWorker();
        } catch {
          resolve({ ok: false, error: 'Regex search is unavailable (worker failed to start)' });
          return;
        }
        const timer = setTimeout(
          () => settle({ ok: false, error: 'Regex worker failed to start' }, true),
          startupMs
        );
        inflight = { id, timer, resolve };
        try {
          w.postMessage({ id, pattern, flags: REGEX_FLAGS, texts });
        } catch {
          settle({ ok: false, error: 'Regex search failed' }, true);
        }
      });
    },
    dispose() {
      settle({ ok: false, error: 'Disposed', cancelled: true }, true);
      worker?.terminate();
      worker = null;
    },
  };
}
