/**
 * Pure mapping from a GraphQL response's `errors[]` (spec §7.1.2) to the
 * places a user wants to look: the query source (`locations` → editor
 * ranges/markers) and the partial data (`path` → response-tree node).
 *
 * Everything here tolerates arbitrary upstream JSON — the body is untrusted.
 */

/** A 1-based line/column into the *sent* query document, as GraphQL reports it. */
export interface GraphQLErrorLocation {
  line: number;
  column: number;
}

export type GraphQLErrorPathSegment = string | number;

export interface GraphQLErrorEntry {
  /** Position in the response's `errors` array. */
  index: number;
  message: string;
  locations: GraphQLErrorLocation[];
  /** Response path, or `null` when absent/malformed (e.g. request errors). */
  path: GraphQLErrorPathSegment[] | null;
  /** `extensions.code` when it's a string. */
  code?: string;
}

/** Monaco-shaped 1-based range (no Monaco import so this stays pure). */
export interface GraphQLErrorRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface GraphQLErrorMarker extends GraphQLErrorRange {
  /** MarkerSeverity.Error */
  severity: 8;
  message: string;
  source: string;
}

/**
 * `protocolOptions` key for a `(sentBody: string) => void` callback the GraphQL
 * protocol invokes with the substituted body it sent.
 */
export const GRAPHQL_SENT_BODY_OPTION = 'onSentBody';

/** Upper bound on errors we materialise — a hostile server can send millions. */
export const MAX_GRAPHQL_ERRORS = 200;
const MAX_LOCATIONS_PER_ERROR = 20;
const UNKNOWN_MESSAGE = 'Unknown GraphQL error';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function parseLocations(raw: unknown): GraphQLErrorLocation[] {
  if (!Array.isArray(raw)) return [];
  const out: GraphQLErrorLocation[] = [];
  for (const loc of raw.slice(0, MAX_LOCATIONS_PER_ERROR)) {
    if (!isRecord(loc)) continue;
    const { line, column } = loc;
    if (
      typeof line === 'number' &&
      typeof column === 'number' &&
      Number.isInteger(line) &&
      Number.isInteger(column) &&
      line >= 1 &&
      column >= 1
    ) {
      out.push({ line, column });
    }
  }
  return out;
}

function parsePath(raw: unknown): GraphQLErrorPathSegment[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  for (const seg of raw) {
    const ok =
      typeof seg === 'string' || (typeof seg === 'number' && Number.isInteger(seg) && seg >= 0);
    if (!ok) return null;
  }
  return raw as GraphQLErrorPathSegment[];
}

function parseOne(raw: unknown, index: number): GraphQLErrorEntry {
  if (typeof raw === 'string') return { index, message: raw, locations: [], path: null };
  if (!isRecord(raw)) return { index, message: UNKNOWN_MESSAGE, locations: [], path: null };
  const message = typeof raw.message === 'string' ? raw.message : UNKNOWN_MESSAGE;
  const code = isRecord(raw.extensions) ? raw.extensions.code : undefined;
  return {
    index,
    message,
    locations: parseLocations(raw.locations),
    path: parsePath(raw.path),
    ...(typeof code === 'string' ? { code } : {}),
  };
}

/** Normalise the `errors` of a GraphQL result payload (HTTP body or subscription `next`). */
export function parseGraphQLErrors(payload: unknown): GraphQLErrorEntry[] {
  if (!isRecord(payload)) return [];
  const { errors } = payload;
  if (!Array.isArray(errors)) return [];
  return errors.slice(0, MAX_GRAPHQL_ERRORS).map(parseOne);
}

/** {@link parseGraphQLErrors} for a raw response body; `[]` when it isn't JSON. */
export function parseGraphQLErrorsFromBody(body: string): GraphQLErrorEntry[] {
  if (!body) return [];
  try {
    return parseGraphQLErrors(JSON.parse(body) as unknown);
  } catch {
    return [];
  }
}

/** Start offsets of each line. Line terminators follow graphql-js: \r\n, \n, \r. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    const ch = source.charCodeAt(i);
    if (ch === 13 /* \r */) {
      if (source.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    } else if (ch === 10 /* \n */) {
      starts.push(i + 1);
    }
  }
  return starts;
}

/** Offset of the end of line `lineIdx` (0-based), excluding its terminator. */
function lineEnd(source: string, starts: number[], lineIdx: number): number {
  const next = starts[lineIdx + 1];
  if (next === undefined) return source.length;
  let end = next - 1;
  if (source.charCodeAt(end) === 10 && source.charCodeAt(end - 1) === 13) end--;
  return end;
}

/**
 * 0-based UTF-16 offset for a GraphQL location. graphql-js columns count UTF-16
 * code units, the same unit as JS string indices and Monaco columns. Lines and
 * columns beyond the document are clamped into it (the query may have been
 * edited since it was sent).
 */
export function locationToOffset(source: string, loc: GraphQLErrorLocation): number {
  const starts = lineStarts(source);
  const lineIdx = Math.min(Math.max(loc.line, 1), starts.length) - 1;
  const start = starts[lineIdx] ?? 0;
  const end = lineEnd(source, starts, lineIdx);
  return Math.min(start + Math.max(loc.column, 1) - 1, end);
}

const NAME_CHAR = /[_A-Za-z0-9]/;

/**
 * The editor range to underline for a location: the GraphQL name token there
 * (including a leading `$`/`@` sigil), or a single character otherwise.
 */
export function locationToRange(source: string, loc: GraphQLErrorLocation): GraphQLErrorRange {
  const starts = lineStarts(source);
  const offset = locationToOffset(source, loc);
  let lineIdx = 0;
  while (lineIdx + 1 < starts.length && (starts[lineIdx + 1] ?? Infinity) <= offset) lineIdx++;
  const lineStart = starts[lineIdx] ?? 0;
  const end = lineEnd(source, starts, lineIdx);

  let tokenEnd = offset;
  const first = source[offset];
  if (first === '$' || first === '@') tokenEnd++;
  while (tokenEnd < end && NAME_CHAR.test(source[tokenEnd] ?? '')) tokenEnd++;
  if (tokenEnd === offset && offset < end) tokenEnd++;

  return {
    startLineNumber: lineIdx + 1,
    startColumn: offset - lineStart + 1,
    endLineNumber: lineIdx + 1,
    endColumn: tokenEnd - lineStart + 1,
  };
}

/** 1-based position of a 0-based offset (same line rules as {@link locationToOffset}). */
function offsetToPosition(source: string, offset: number): { line: number; column: number } {
  const starts = lineStarts(source);
  let lineIdx = 0;
  while (lineIdx + 1 < starts.length && (starts[lineIdx + 1] ?? Infinity) <= offset) lineIdx++;
  return { line: lineIdx + 1, column: offset - (starts[lineIdx] ?? 0) + 1 };
}

function offsetsToRange(source: string, start: number, end: number): GraphQLErrorRange {
  const a = offsetToPosition(source, start);
  const b = offsetToPosition(source, end);
  return {
    startLineNumber: a.line,
    startColumn: a.column,
    endLineNumber: b.line,
    endColumn: b.column,
  };
}

const PLACEHOLDER = /\{\{[^{}]+\}\}/g;

interface AlignedSegment {
  kind: 'literal' | 'placeholder';
  rawStart: number;
  rawEnd: number;
  sentStart: number;
  sentEnd: number;
}

/**
 * Line up the editor text (`raw`, with `{{var}}` placeholders) against the
 * text that was actually sent (`sent`, placeholders substituted). Literal text
 * between placeholders must appear verbatim and in order; adjacent
 * placeholders collapse into one region. `null` when they can't be aligned
 * (the sent text came from something other than substitution).
 */
function alignSentText(raw: string, sent: string): AlignedSegment[] | null {
  const literals: Array<{ start: number; end: number }> = [];
  const holes: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const m of raw.matchAll(PLACEHOLDER)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const prevHole = holes[holes.length - 1];
    if (prevHole && prevHole.end === start) {
      prevHole.end = end;
    } else {
      literals.push({ start: cursor, end: start });
      holes.push({ start, end });
    }
    cursor = end;
  }
  literals.push({ start: cursor, end: raw.length });

  const segments: AlignedSegment[] = [];
  let pos = 0;
  for (let i = 0; i < literals.length; i++) {
    const lit = literals[i]!;
    const text = raw.slice(lit.start, lit.end);
    const isFirst = i === 0;
    const isLast = i === literals.length - 1;
    let at: number;
    if (isFirst) at = sent.startsWith(text) ? 0 : -1;
    else if (isLast) at = sent.endsWith(text) ? sent.length - text.length : -1;
    else at = sent.indexOf(text, pos);
    if (at < pos || (isFirst && isLast && text.length !== sent.length)) return null;
    if (!isFirst) {
      const hole = holes[i - 1]!;
      segments.push({
        kind: 'placeholder',
        rawStart: hole.start,
        rawEnd: hole.end,
        sentStart: pos,
        sentEnd: at,
      });
    }
    segments.push({
      kind: 'literal',
      rawStart: lit.start,
      rawEnd: lit.end,
      sentStart: at,
      sentEnd: at + text.length,
    });
    pos = at + text.length;
  }

  // Ambiguity check: the forward pass placed every literal at its EARLIEST
  // feasible position; a backward pass places each at its LATEST. Any valid
  // alignment lies between the two, so they agree iff the alignment is unique.
  // When they differ, a substituted value contains a following literal (e.g.
  // `{ {{x}}a{{y}} }` sent as `{ aaa }`) and we can't tell which match is real.
  let end = sent.length;
  // Index 0 is the first literal, pinned at offset 0 by `startsWith`.
  for (let i = segments.length - 1; i > 0; i--) {
    const seg = segments[i]!;
    if (seg.kind !== 'literal') continue;
    const len = seg.sentEnd - seg.sentStart;
    const latest = sent.lastIndexOf(raw.slice(seg.rawStart, seg.rawEnd), end - len);
    if (latest !== seg.sentStart) return null;
    end = latest;
  }
  return segments;
}

/**
 * Editor range for a location reported against the SENT query. The request
 * executor substitutes `{{vars}}` in the query text before sending, so server
 * coordinates index the substituted text; map them back onto the editor text.
 * A location inside a substituted value highlights the whole placeholder.
 * `null` when the two texts can't be aligned — better no marker than a wrong one.
 */
export function sentLocationToRange(
  raw: string,
  sent: string,
  loc: GraphQLErrorLocation
): GraphQLErrorRange | null {
  if (raw === sent) return locationToRange(raw, loc);
  const segments = alignSentText(raw, sent);
  if (!segments) return null;
  const sentRange = locationToRange(sent, loc);
  const start = locationToOffset(sent, {
    line: sentRange.startLineNumber,
    column: sentRange.startColumn,
  });
  const end = start + (sentRange.endColumn - sentRange.startColumn);
  const seg =
    segments.find((s) => start >= s.sentStart && start < s.sentEnd) ??
    segments[segments.length - 1];
  if (!seg) return null;
  if (seg.kind === 'placeholder') return offsetsToRange(raw, seg.rawStart, seg.rawEnd);
  const rawStart = seg.rawStart + (start - seg.sentStart);
  const rawEnd = seg.rawStart + (Math.min(end, seg.sentEnd) - seg.sentStart);
  return offsetsToRange(raw, rawStart, Math.max(rawEnd, rawStart));
}

/** The `query` of a sent GraphQL JSON envelope, if that's what `body` is. */
export function sentQueryFromBody(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    return isRecord(parsed) && typeof parsed.query === 'string' ? parsed.query : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Editor markers for every located error. `sent` is the query text the server
 * saw (after `{{var}}` substitution); locations that can't be mapped back onto
 * `source` are dropped.
 */
export function buildErrorMarkers(
  source: string,
  errors: readonly GraphQLErrorEntry[],
  sent: string = source
): GraphQLErrorMarker[] {
  const markers: GraphQLErrorMarker[] = [];
  for (const error of errors) {
    const message = errorLabel(error);
    for (const loc of error.locations) {
      const range = sentLocationToRange(source, sent, loc);
      if (!range) continue;
      markers.push({ severity: 8, message, source: 'GraphQL response', ...range });
    }
  }
  return markers;
}

/** `user.friends[1].name` */
export function formatErrorPath(path: readonly GraphQLErrorPathSegment[] | null): string {
  if (!path) return '';
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out ? `.${seg}` : seg;
  }
  return out;
}

/** Response paths are relative to `data`; the tree shows the whole envelope. */
export function errorTreePath(path: readonly GraphQLErrorPathSegment[]): GraphQLErrorPathSegment[] {
  return ['data', ...path];
}

/**
 * Longest prefix of `path` that exists in `root`. Errors null out the nearest
 * nullable ancestor, so a path often points below a `null` — highlight the
 * deepest node that is actually rendered.
 */
export function resolveExistingPath(
  root: unknown,
  path: readonly GraphQLErrorPathSegment[]
): GraphQLErrorPathSegment[] {
  const out: GraphQLErrorPathSegment[] = [];
  let node: unknown = root;
  for (const seg of path) {
    if (typeof seg === 'number') {
      if (!Array.isArray(node) || seg >= node.length) break;
      node = node[seg];
    } else {
      if (!isRecord(node) || !Object.hasOwn(node, seg)) break;
      node = node[seg];
    }
    out.push(seg);
  }
  return out;
}

/** Short one-line label: `[CODE] message`. */
export function errorLabel(error: GraphQLErrorEntry): string {
  return error.code ? `[${error.code}] ${error.message}` : error.message;
}

/**
 * Tree highlights for every error with a `path`, resolved against the parsed
 * envelope (`root`) so each lands on a node that is actually rendered.
 */
export function errorTreeHighlights(
  root: unknown,
  errors: readonly GraphQLErrorEntry[]
): Array<{ path: GraphQLErrorPathSegment[]; label: string }> {
  const out: Array<{ path: GraphQLErrorPathSegment[]; label: string }> = [];
  for (const error of errors) {
    if (!error.path) continue;
    const path = resolveExistingPath(root, errorTreePath(error.path));
    if (path.length === 0) continue;
    out.push({ path, label: errorLabel(error) });
  }
  return out;
}

export interface SubscriptionErrorEntry {
  messageId: string;
  payload: unknown;
  error: GraphQLErrorEntry;
}

interface SubscriptionMessageLike {
  id: string;
  type: string;
  payload?: unknown;
}

/** Errors carried by subscription `next` payloads, in arrival order (most recent kept). */
export function subscriptionErrors(
  messages: readonly SubscriptionMessageLike[]
): SubscriptionErrorEntry[] {
  const out: SubscriptionErrorEntry[] = [];
  for (const msg of messages) {
    if (msg.type !== 'data') continue;
    for (const error of parseGraphQLErrors(msg.payload)) {
      out.push({ messageId: msg.id, payload: msg.payload, error });
    }
  }
  return out.length > MAX_GRAPHQL_ERRORS ? out.slice(-MAX_GRAPHQL_ERRORS) : out;
}

export function summarizeGraphQLErrors(count: number): string {
  return `GraphQL returned ${count} error${count === 1 ? '' : 's'}`;
}
