import type { KeyValue } from '@/types';

/**
 * Two-way sync between the URL bar text and the request's params table.
 *
 * Persisted shape is unchanged: `request.url` holds everything except the
 * query (importers already strip it), and `request.params` holds the query
 * rows that the executor appends at send time. The URL bar *displays*
 * `url + enabled params`, and editing it splits the text back into the two.
 * Disabled rows never appear in the URL, so a URL edit leaves them alone.
 */

interface SplitUrl {
  base: string;
  query: string;
  hash: string;
}

export function splitUrl(url: string): SplitUrl {
  const hashAt = url.indexOf('#');
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  if (queryAt === -1) return { base: beforeHash, query: '', hash };
  return { base: beforeHash.slice(0, queryAt), query: beforeHash.slice(queryAt + 1), hash };
}

// Values are stored decoded (the executor encodes them on the wire), so decode
// what the user typed or pasted. Malformed escapes (e.g. a literal "100%") are
// kept verbatim. "+" is left alone rather than treated as a space.
function decodePart(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// Escape only what would otherwise change how the text re-parses, so the bar
// stays readable and {{var}} tokens are untouched.
function encodePart(text: string, isKey: boolean): string {
  const out = text
    .replace(/%(?=[0-9A-Fa-f]{2})/g, '%25')
    .replace(/&/g, '%26')
    .replace(/#/g, '%23');
  return isKey ? out.replace(/=/g, '%3D') : out;
}

export function parseQuery(query: string): Array<{ key: string; value: string }> {
  if (!query) return [];
  return query
    .split('&')
    .filter((pair) => pair !== '')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return { key: decodePart(pair), value: '' };
      return { key: decodePart(pair.slice(0, eq)), value: decodePart(pair.slice(eq + 1)) };
    });
}

function serializeQuery(params: ReadonlyArray<Pick<KeyValue, 'key' | 'value'>>): string {
  return params
    .map(({ key, value }) =>
      value === '' ? encodePart(key, true) : `${encodePart(key, true)}=${encodePart(value, false)}`
    )
    .join('&');
}

/** The text the URL bar shows: stored URL plus every enabled, keyed param. */
export function buildDisplayUrl(url: string, params: ReadonlyArray<KeyValue>): string {
  const { base, query, hash } = splitUrl(url);
  const fromParams = serializeQuery(params.filter((p) => p.enabled && p.key));
  const fullQuery = [query, fromParams].filter(Boolean).join('&');
  return `${base}${fullQuery ? `?${fullQuery}` : ''}${hash}`;
}

/**
 * Split URL-bar text into the stored `url` (no query) and an updated params
 * list. Existing enabled rows are matched by key in order, keeping their id,
 * description and position; unmatched enabled rows are removed; disabled and
 * key-less rows are kept as-is; new pairs are appended.
 */
export function applyUrlInput(
  input: string,
  params: ReadonlyArray<KeyValue>,
  makeId: () => string
): { url: string; params: KeyValue[] } {
  const { base, query, hash } = splitUrl(input);
  const pairs = parseQuery(query);
  const used = new Set<number>();
  const claim = (row: KeyValue): { key: string; value: string } | undefined => {
    const index = pairs.findIndex((p, i) => !used.has(i) && p.key === row.key);
    if (index === -1) return undefined;
    used.add(index);
    return pairs[index];
  };

  const next: KeyValue[] = [];
  for (const row of params) {
    if (!row.enabled || !row.key) {
      next.push(row);
      continue;
    }
    const match = claim(row);
    if (match) next.push(match.value === row.value ? row : { ...row, value: match.value });
  }
  pairs.forEach((pair, i) => {
    if (!used.has(i)) next.push({ id: makeId(), key: pair.key, value: pair.value, enabled: true });
  });

  return { url: `${base}${hash}`, params: next };
}

/** A pasted URL-bar value that should be imported as a whole request. */
export function looksLikeCurl(text: string): boolean {
  return /^\s*curl(\.exe)?\s/i.test(text);
}
