/**
 * Postman-style path variables: a whole `:name` path segment
 * (`/users/:id/posts`) replaced at send time by the request's `pathVariables`
 * row of that name. ONE implementation for every host — the renderer (web,
 * self-host and desktop all build their spec in `requestExecutor`), the CLI
 * executor and the code generators — so the URL each sends cannot drift.
 *
 * Rules (the postman-collection SDK's `Url.getPath`, which Newman runs):
 *   - only the path is read: never the scheme, the `user:pass@host:port`
 *     authority, the query or the fragment;
 *   - a variable is a WHOLE segment, `:` followed by a non-empty name without
 *     `{{` (a bare `:`, `a:b` and `x:` are literal text);
 *   - an enabled row with a non-empty (resolved) value substitutes every
 *     occurrence; a disabled row, an empty value, or a name with no row leaves
 *     the segment literal (Postman sends an unknown `:name` as written);
 *   - the value is resolved (`{{var}}`) by the host, then percent-encoded as
 *     ONE path segment: `/`, `\`, `?` and `#` are always escaped, so a value
 *     can never add segments, start a query or reach the authority. A value of
 *     `.` or `..` is still normalised by URL parsing (it can drop a segment of
 *     the path, never touch the host). Existing `%XX` escapes are kept.
 */

import { replaceVariableTokens } from '../variables/tokens';

export interface PathVariableRow {
  key: string;
  value: string;
  enabled?: boolean;
}

export interface ApplyPathVariablesOptions<T extends PathVariableRow> {
  /** The row's final value: the host resolves `{{var}}` tokens in `row.value`. */
  resolve: (row: T) => string;
  /**
   * The request's "encode URL automatically". Off: only `/`, `?`, `#` and a
   * stray `%` are escaped (they would change the URL's structure).
   */
  encode?: boolean;
  /**
   * Tokens a later stage materializes (desktop secret handles, substituted by
   * Electron main at the wire edge) stay verbatim instead of being encoded.
   */
  keepToken?: (name: string) => boolean;
}

/** Index where the path starts and where it ends (before `?` / `#`). */
function pathBounds(url: string): { start: number; end: number } {
  const hash = url.indexOf('#');
  const beforeHash = hash === -1 ? url : url.slice(0, hash);
  const q = beforeHash.indexOf('?');
  const end = q === -1 ? beforeHash.length : q;
  const scheme = beforeHash.indexOf('://');
  const authorityStart = scheme !== -1 && scheme < end ? scheme + 3 : 0;
  const slash = beforeHash.indexOf('/', authorityStart);
  const start = slash === -1 || slash > end ? end : slash;
  return { start, end };
}

/** The variable name of a whole `:name` segment, else undefined. */
function segmentName(segment: string): string | undefined {
  if (segment.length < 2 || segment[0] !== ':') return undefined;
  const name = segment.slice(1);
  if (name.includes(':') || name.includes('{{')) return undefined;
  return name;
}

/** The distinct path-variable names in `url`, in path order. */
export function pathVariableNames(url: string): string[] {
  const { start, end } = pathBounds(url);
  const seen = new Set<string>();
  for (const segment of url.slice(start, end).split('/')) {
    const name = segmentName(segment);
    if (name !== undefined) seen.add(name);
  }
  return [...seen];
}

const PCHAR = /[A-Za-z0-9\-._~!$&'()*+,;=:@]/;
const PERCENT_ESCAPE = /^%[0-9A-Fa-f]{2}$/;

/** Percent-encode `text` as one RFC 3986 path segment, keeping valid `%XX`. */
function encodeSegment(text: string, encode: boolean): string {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) as number;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (ch === '%') {
      out += PERCENT_ESCAPE.test(text.slice(i - 1, i + 2)) ? '%' : '%25';
    } else if (ch === '/' || ch === '\\' || ch === '?' || ch === '#') {
      out += encodeURIComponent(ch);
    } else if (!encode || PCHAR.test(ch)) {
      out += ch;
    } else {
      out += encodeURIComponent(ch);
    }
  }
  return out;
}

function encodeValue(value: string, encode: boolean, keepToken?: (name: string) => boolean) {
  if (!keepToken) return encodeSegment(value, encode);
  // Encode the text between kept tokens; the tokens themselves stay intact.
  const KEEP = '\u0000';
  const kept: string[] = [];
  const masked = replaceVariableTokens(value, (name, raw) => {
    if (!keepToken(name)) return raw;
    kept.push(raw);
    return KEEP;
  });
  if (kept.length === 0) return encodeSegment(value, encode);
  return masked
    .split(KEEP)
    .map((part, i) => encodeSegment(part, encode) + (kept[i] ?? ''))
    .join('');
}

/** `url` with every `:name` path segment that has a sendable row substituted. */
export function applyPathVariables<T extends PathVariableRow>(
  url: string,
  rows: readonly T[] | undefined,
  options: ApplyPathVariablesOptions<T>
): string {
  if (!rows || rows.length === 0) return url;
  const { start, end } = pathBounds(url);
  const names = new Set(pathVariableNames(url));
  if (names.size === 0) return url;
  const encode = options.encode !== false;
  const values = new Map<string, string>();
  for (const row of rows) {
    if (row.enabled === false || !names.has(row.key)) continue;
    const value = options.resolve(row);
    if (value !== '') values.set(row.key, encodeValue(value, encode, options.keepToken));
  }
  if (values.size === 0) return url;
  const path = url
    .slice(start, end)
    .split('/')
    .map((segment) => {
      const name = segmentName(segment);
      return name !== undefined && values.has(name) ? (values.get(name) as string) : segment;
    })
    .join('/');
  return url.slice(0, start) + path + url.slice(end);
}

/**
 * Rows kept in step with `url`: one per distinct `:name` in path order, an
 * existing row (value, description, enabled, id) kept for a name that
 * remains, a fresh empty row for a new name, rows for removed names dropped.
 * Returns `current` itself when nothing changed, so callers can skip a write.
 */
export function syncPathVariableRows<
  T extends { id: string; key: string; value: string; enabled: boolean },
>(url: string, current: readonly T[] | undefined, makeId: () => string): T[] {
  const names = pathVariableNames(url);
  const existing = current ?? [];
  const byKey = new Map<string, T>();
  for (const row of existing) if (!byKey.has(row.key)) byKey.set(row.key, row);
  const next = names.map(
    (key) => byKey.get(key) ?? ({ id: makeId(), key, value: '', enabled: true } as T)
  );
  const unchanged = next.length === existing.length && next.every((row, i) => row === existing[i]);
  return unchanged && current ? (current as T[]) : next;
}
