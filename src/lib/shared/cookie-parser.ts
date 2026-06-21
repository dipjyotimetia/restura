/**
 * Best-effort Cookie / Set-Cookie parsing for the console detail view.
 * Not RFC 6265 perfect — for example, no handling of `Expires=...; <day>, <date>`
 * commas inside a single Set-Cookie value. We accept the array shape the proxy
 * already produces (each Set-Cookie is a separate array element) and fall back
 * to a comma-aware splitter only when given a single concatenated string.
 */

export interface RequestCookie {
  name: string;
  value: string;
}

export interface ResponseCookie extends RequestCookie {
  domain?: string;
  path?: string;
  expires?: string;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

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

/** Parse `Set-Cookie` (often an array) into structured response cookies. */
export function parseResponseCookies(headers: Record<string, string | string[]>): ResponseCookie[] {
  const raw = findHeader(headers, 'set-cookie');
  if (raw === undefined) return [];
  const list = Array.isArray(raw)
    ? raw
    : // Multiple Set-Cookie folded into one header — split on commas that
      // precede a `name=` token, leaving date commas (e.g. `Expires=Wed, 01…`)
      // intact.
      raw.split(/,(?=\s*[A-Za-z0-9!#$%&'*+\-.^_`|~]+\s*=)/);
  return list.map(parseSetCookieValue).filter((c): c is ResponseCookie => c !== null);
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

function parseSetCookieValue(raw: string): ResponseCookie | null {
  const parts = splitPairs(raw, ';');
  if (parts.length === 0) return null;
  const head = parseNameValue(parts[0]!);
  if (!head) return null;
  const out: ResponseCookie = { name: head.name, value: head.value };
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i]!;
    const eq = seg.indexOf('=');
    const key = (eq < 0 ? seg : seg.slice(0, eq)).trim().toLowerCase();
    const val = eq < 0 ? '' : seg.slice(eq + 1).trim();
    switch (key) {
      case 'domain':
        out.domain = val;
        break;
      case 'path':
        out.path = val;
        break;
      case 'expires':
        out.expires = val;
        break;
      case 'max-age': {
        const n = Number(val);
        if (Number.isFinite(n)) out.maxAge = n;
        break;
      }
      case 'httponly':
        out.httpOnly = true;
        break;
      case 'secure':
        out.secure = true;
        break;
      case 'samesite':
        out.sameSite = val;
        break;
      default:
        /* unknown attribute — silently ignored */ break;
    }
  }
  return out;
}
