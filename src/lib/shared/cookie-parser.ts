/**
 * Best-effort Cookie / Set-Cookie parsing for the console detail view.
 * Not RFC 6265 perfect. Response cookies come from the shared Set-Cookie
 * module (`@shared/protocol/set-cookie`), which prefers the per-field list and
 * keeps `Expires=...; <day>, <date>` commas intact when splitting a folded
 * header.
 */

import {
  type ParsedSetCookie,
  parseResponseSetCookies,
  type SetCookieSource,
} from '@shared/protocol/set-cookie';

export interface RequestCookie {
  name: string;
  value: string;
}

export type ResponseCookie = ParsedSetCookie;

function findHeader(
  headers: Record<string, string | string[]>,
  name: string
): string | string[] | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

/** Parse a request `Cookie: a=1; b=2` header into cookies. */
export function parseRequestCookies(headers: Record<string, string | string[]>): RequestCookie[] {
  const raw = findHeader(headers, 'cookie');
  if (raw === undefined) return [];
  const flat = Array.isArray(raw) ? raw.join('; ') : raw;
  return splitPairs(flat, ';')
    .map(parseNameValue)
    .filter((c): c is RequestCookie => c !== null);
}

/**
 * Every Set-Cookie on a response, parsed. Reads the per-field `setCookies` list
 * (#855) first; the flat header map (array, or a folded string split on cookie
 * boundaries) is only the fallback for entries captured before the list.
 */
export function parseResponseCookies(response: SetCookieSource): ResponseCookie[] {
  return parseResponseSetCookies(response);
}

function splitPairs(value: string, sep: string): string[] {
  return value
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseNameValue(pair: string): RequestCookie | null {
  const eq = pair.indexOf('=');
  if (eq < 0) return null;
  const name = pair.slice(0, eq).trim();
  if (!name) return null;
  const value = pair.slice(eq + 1).trim();
  return { name, value };
}
