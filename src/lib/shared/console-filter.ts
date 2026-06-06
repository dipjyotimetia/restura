/**
 * Network-console filter DSL. The free-text "Filter requests…" box is parsed
 * as a series of whitespace-separated tokens; each token is one of:
 *
 *   plain text         → substring match anywhere (url / method / status /
 *                        statusText / either body / any header name or value)
 *   "quoted text"      → same, but preserves spaces
 *   key:value          → field-scoped match (case-insensitive)
 *   key:~regex         → regex match on the named field (url / body)
 *   -<anything above>  → negation (entry must NOT match)
 *
 * Supported keys: status, method, url, protocol, host, has, run.
 *   status:200 / status:2xx / status:5xx / status:errored
 *   method:POST
 *   url:/users         host:api.example.com
 *   protocol:graphql   run:smoke
 *   has:body | has:cookie | has:test | has:script
 *
 * Multiple tokens AND together (matching DevTools' "filter expressions").
 *
 * The parser is deliberately forgiving: a malformed regex falls back to a
 * literal substring match, an unknown `key:` is treated as plain text. Bad
 * input narrows the result set, never throws.
 */

import type { ConsoleEntry, ConsoleStatusFilter } from '@/store/useConsoleStore';

type FieldKey = 'status' | 'method' | 'url' | 'protocol' | 'host' | 'has' | 'run';
const FIELD_KEYS: ReadonlySet<string> = new Set([
  'status',
  'method',
  'url',
  'protocol',
  'host',
  'has',
  'run',
]);

/**
 * Cap on the length of a user-typed regex pattern. Captured URLs are short
 * (~< 2 KB), so realistic ReDoS risk is limited, but a pathological pattern
 * like `(a+)+$` against a long URL can still freeze the renderer. A 256-char
 * cap rejects deeply nested patterns without inconveniencing real use.
 * Over-length patterns fall back to literal-substring matching.
 */
const MAX_REGEX_LENGTH = 256;

export interface FilterToken {
  negated: boolean;
  /** Field-scoped (key set) or free-text. */
  field?: FieldKey;
  /** Raw value as typed (trimmed, unquoted). */
  value: string;
  /** Compiled regex when value started with `~` and parsed successfully. */
  regex?: RegExp;
}

/** Split a query into tokens, respecting "quoted spans". */
function lex(input: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (buf) {
        out.push(buf);
        buf = '';
      }
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

export function parseQuery(input: string): FilterToken[] {
  const tokens: FilterToken[] = [];
  for (const raw of lex(input.trim())) {
    let s = raw;
    let negated = false;
    if (s.startsWith('-') && s.length > 1) {
      negated = true;
      s = s.slice(1);
    }
    const colon = s.indexOf(':');
    let field: FieldKey | undefined;
    let value = s;
    if (colon > 0) {
      const k = s.slice(0, colon).toLowerCase();
      if (FIELD_KEYS.has(k)) {
        field = k as FieldKey;
        value = s.slice(colon + 1);
      }
    }
    const tok: FilterToken = { negated, value };
    if (field) tok.field = field;
    if (value.startsWith('~') && value.length > 1 && value.length - 1 <= MAX_REGEX_LENGTH) {
      try {
        tok.regex = new RegExp(value.slice(1), 'i');
      } catch {
        /* fall through — literal match on the raw value */
      }
    }
    tokens.push(tok);
  }
  return tokens;
}

/** Status class check, reused outside the DSL too (e.g. by chip predicates). */
export function statusMatchesClass(status: number, filter: ConsoleStatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'errored') return status === 0 || status >= 500;
  if (filter === '2xx') return status >= 200 && status < 300;
  if (filter === '3xx') return status >= 300 && status < 400;
  if (filter === '4xx') return status >= 400 && status < 500;
  if (filter === '5xx') return status >= 500 && status < 600;
  return true;
}

function statusToken(status: number, raw: string): boolean {
  const v = raw.toLowerCase();
  if (v === 'errored' || v === '2xx' || v === '3xx' || v === '4xx' || v === '5xx') {
    return statusMatchesClass(status, v as ConsoleStatusFilter);
  }
  // numeric: exact (200) or prefix ("5" matches any 5xx).
  if (/^\d+$/.test(v)) {
    return status.toString().startsWith(v);
  }
  return false;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

function headerHit(h: Record<string, string | string[]>, needle: string): boolean {
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase().includes(needle)) return true;
    const flat = Array.isArray(v) ? v.join(',') : v;
    if (flat.toLowerCase().includes(needle)) return true;
  }
  return false;
}

function hasCookieHeader(h: Record<string, string | string[]>): boolean {
  for (const k of Object.keys(h)) {
    const lk = k.toLowerCase();
    if (lk === 'cookie' || lk === 'set-cookie') return true;
  }
  return false;
}

/** Evaluate a single token against an entry. Field tokens use the named field;
 *  free-text searches the same surfaces as the legacy literal-substring search. */
function tokenMatches(entry: ConsoleEntry, t: FilterToken): boolean {
  // Partial-token guard: `status:` / `method:` mid-typing shouldn't empty the
  // list — treat a field token with no value (and no regex) as a no-op.
  if (t.field && !t.value && !t.regex) return true;

  const v = t.value.toLowerCase();

  // Field-scoped tokens.
  if (t.field === 'status') return statusToken(entry.response.status, t.value);
  if (t.field === 'method')
    return (
      entry.request.method.toLowerCase() === v || entry.request.method.toLowerCase().includes(v)
    );
  if (t.field === 'protocol') return (entry.protocol ?? 'http').toLowerCase() === v;
  if (t.field === 'host') return hostOf(entry.request.url).includes(v);
  if (t.field === 'run') {
    // Match either the label or the id — labels are user-friendly, ids are
    // shareable in URLs; `run:` should accept whichever the user happens to
    // have in clipboard.
    const label = (entry.runLabel ?? '').toLowerCase();
    const id = (entry.runId ?? '').toLowerCase();
    return label.includes(v) || id.includes(v);
  }
  if (t.field === 'has') {
    if (v === 'body') return !!entry.request.body || entry.response.body.length > 0;
    if (v === 'cookie')
      return (
        hasCookieHeader(entry.request.headers as Record<string, string | string[]>) ||
        hasCookieHeader(entry.response.headers)
      );
    if (v === 'test') return (entry.tests?.length ?? 0) > 0;
    if (v === 'script') return (entry.scriptLogs?.length ?? 0) > 0;
    return false;
  }
  if (t.field === 'url') {
    if (t.regex) return t.regex.test(entry.request.url);
    return entry.request.url.toLowerCase().includes(v);
  }

  // Free-text — broad surface scan (same as the prior literal-substring matcher).
  if (t.regex) return t.regex.test(entry.request.url);
  if (!v) return true; // empty token after parsing → no-op
  if (entry.request.url.toLowerCase().includes(v)) return true;
  if (entry.request.method.toLowerCase().includes(v)) return true;
  if (entry.response.status.toString().includes(v)) return true;
  if (entry.response.statusText.toLowerCase().includes(v)) return true;
  if (entry.request.body?.toLowerCase().includes(v)) return true;
  if (entry.response.body.toLowerCase().includes(v)) return true;
  if (headerHit(entry.request.headers as Record<string, string | string[]>, v)) return true;
  if (headerHit(entry.response.headers, v)) return true;
  return false;
}

/** Match an entry against a pre-parsed token list — preferred when filtering
 *  many entries with the same query (parse the query once, reuse the tokens).
 *  An empty token list matches everything. */
export function matchesTokens(entry: ConsoleEntry, tokens: FilterToken[]): boolean {
  if (tokens.length === 0) return true;
  for (const t of tokens) {
    const hit = tokenMatches(entry, t);
    if (t.negated ? hit : !hit) return false;
  }
  return true;
}

/** Single-entry convenience that parses the query each call. Use
 *  `parseQuery` + `matchesTokens` instead when iterating a list. */
export function matchesQuery(entry: ConsoleEntry, query: string): boolean {
  return matchesTokens(entry, parseQuery(query));
}

export interface FilterCriteria {
  query: string;
  statusFilter: ConsoleStatusFilter;
  protocolFilter: string; // ConsoleProtocol | 'all'
  runFilter: string; // run id or 'all'
}

/** Apply all four console filters (text query + status class + protocol + run).
 *  The text query is parsed exactly once for the whole list; without this,
 *  every keystroke recompiled each regex token N times (once per entry). */
export function filterEntries(entries: ConsoleEntry[], c: FilterCriteria): ConsoleEntry[] {
  const tokens = parseQuery(c.query);
  return entries.filter((entry) => {
    if (!statusMatchesClass(entry.response.status, c.statusFilter)) return false;
    if (c.protocolFilter !== 'all' && (entry.protocol ?? 'http') !== c.protocolFilter) return false;
    if (c.runFilter !== 'all' && entry.runId !== c.runFilter) return false;
    return matchesTokens(entry, tokens);
  });
}

export type ConsoleSortBy = 'recent' | 'time' | 'size' | 'status';

/** View-only sort for the Network tab. Pinned entries always group first
 *  (Array.sort is stable, so order within the pinned/unpinned groups is
 *  preserved); 'recent' keeps arrival order within each group. */
export function sortEntries(entries: ConsoleEntry[], sortBy: ConsoleSortBy): ConsoleEntry[] {
  const compare = (a: ConsoleEntry, b: ConsoleEntry): number => {
    if (sortBy === 'time') return b.response.time - a.response.time;
    if (sortBy === 'size') return b.response.size - a.response.size;
    if (sortBy === 'status') return b.response.status - a.response.status;
    return 0; // 'recent' — keep arrival order
  };
  const sorted = [...entries];
  sorted.sort((a, b) => {
    const pinDelta = Number(b.pinned ?? false) - Number(a.pinned ?? false);
    if (pinDelta !== 0) return pinDelta;
    return compare(a, b);
  });
  return sorted;
}

/** Counts per status class, computed once from the unfiltered list — used to
 *  badge the status filter chips so the chips double as a histogram. */
export function statusClassCounts(entries: ConsoleEntry[]): Record<ConsoleStatusFilter, number> {
  const out: Record<ConsoleStatusFilter, number> = {
    all: entries.length,
    '2xx': 0,
    '3xx': 0,
    '4xx': 0,
    '5xx': 0,
    errored: 0,
  };
  for (const e of entries) {
    const s = e.response.status;
    if (s >= 200 && s < 300) out['2xx'] += 1;
    else if (s >= 300 && s < 400) out['3xx'] += 1;
    else if (s >= 400 && s < 500) out['4xx'] += 1;
    else if (s >= 500 && s < 600) out['5xx'] += 1;
    if (s === 0 || s >= 500) out.errored += 1;
  }
  return out;
}
