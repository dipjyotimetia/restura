import { isSecretFieldName } from '../../secrets/key-value-redaction';

/**
 * String-level credential redaction for the `_postman` sidecar (ADR 0034):
 * URLs, header lines, free text (scripts, notes) and launch command lines
 * (MCP stdio `argv` / `command`). Every function both redacts and counts
 * (`counter` defined = count mode) from the same code path, so the export
 * count always equals what redaction blanks. Leaf module: `./redaction.ts`
 * builds on it, never the other way round.
 */

export type Counter = { n: number } | undefined;

/** A value that is exactly one `{{var}}` reference — a pointer, not a secret. */
export const SINGLE_VARIABLE_REFERENCE = /^\{\{\s*[^{}\s]+\s*\}\}$/;

/** Left where a blanked value must stay non-empty (`-p*`); a `*`-only value is already redacted. */
const REDACTED_MASK = '*';

function isSecretText(value: string): boolean {
  const v = value.trim();
  return v !== '' && !/^\*+$/.test(v) && !SINGLE_VARIABLE_REFERENCE.test(v);
}

function bump(counter: Counter): void {
  if (counter) counter.n += 1;
}

// ── URLs: userinfo + credential-named query params ──────────────────────────

const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i;

function decodeComponent(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

/**
 * Strip `user:pass@` userinfo and blank credential-named query values in a
 * URL string; templated URLs survive apart from the credential, and a value
 * that is one `{{var}}` reference is kept. Same policy as
 * `redactUrlCredentialsForStorage` (`shared/secrets/mcp-credential-redaction.ts`),
 * which cannot be imported here: that module depends on collection-redaction,
 * which depends on `./redaction.ts` (runtime cycle).
 */
export function redactUrlCredentialsForStorage(url: string): string {
  const out = url.replace(URL_USERINFO, '$1');
  const queryStart = out.indexOf('?');
  if (queryStart === -1) return out;
  const hashStart = out.indexOf('#', queryStart);
  const end = hashStart === -1 ? out.length : hashStart;
  const query = out
    .slice(queryStart + 1, end)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const value = pair.slice(eq + 1);
      if (!value || SINGLE_VARIABLE_REFERENCE.test(decodeComponent(value).trim())) return pair;
      return isSecretFieldName(decodeComponent(pair.slice(0, eq))) ? `${pair.slice(0, eq)}=` : pair;
    })
    .join('&');
  return `${out.slice(0, queryStart + 1)}${query}${out.slice(end)}`;
}

function queryPairs(url: string): string[] {
  const q = url.indexOf('?');
  if (q === -1) return [];
  const hash = url.indexOf('#', q);
  return url.slice(q + 1, hash === -1 ? url.length : hash).split('&');
}

/** Exactly the number of edits {@link redactUrlCredentialsForStorage} makes to `url`. */
export function countUrlStringSecrets(url: string): number {
  const redacted = redactUrlCredentialsForStorage(url);
  if (redacted === url) return 0;
  const withoutUserinfo = url.replace(URL_USERINFO, '$1');
  const before = queryPairs(withoutUserinfo);
  const after = queryPairs(redacted);
  return (withoutUserinfo === url ? 0 : 1) + before.filter((pair, i) => pair !== after[i]).length;
}

// ── header lines ────────────────────────────────────────────────────────────

const HEADER_LINE = /^([^:]+):(.*)$/s;

/** `Name: value` where the name is a credential and the value a plaintext secret. */
export function isSecretHeaderLine(line: string): boolean {
  const m = HEADER_LINE.exec(line);
  return !!m && isSecretFieldName(String(m[1]).trim()) && isSecretText(String(m[2]));
}

function redactHeaderLine(line: string, counter: Counter): string {
  if (!isSecretHeaderLine(line)) return line;
  bump(counter);
  return `${line.slice(0, line.indexOf(':'))}: `;
}

// ── free text ───────────────────────────────────────────────────────────────

// Every pattern here must stay linear on hostile input (#1210 re-audit: an
// unanchored `[a-z][a-z0-9+.-]*:\/\/` retried at every letter was quadratic,
// seconds per 100 KB, re-run on every export count). Scheme / name matches
// start only at a boundary (lookbehind), so a run of letters is scanned once;
// left context is tracked by one forward scan; every edit only shortens.
const SCHEME_START = /^[a-z][a-z0-9+.-]*:\/\//i;
/**
 * `scheme://userinfo@` inside text; the whole userinfo goes, up to the LAST
 * `@` of the authority (`admin:P@ssw0rd@host`), as on the whole-URL path.
 */
const USERINFO_IN_TEXT = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*):\/\/([^\s/?#]+)@/gi;
/** Schemes whose username is an account name, not a credential (`ssh://deploy@host`). */
const USERNAME_SCHEMES = /^(?:ssh|git|sftp|scp|rsync|git\+ssh|ssh\+git|svn\+ssh)$/i;
/**
 * `?name=value` / `&name=value`, with or without a scheme. Not after `?.`
 * (optional chaining) and not `==` (comparison); `{{ var }}` and a balanced
 * `( … )` stay inside the value; `$ ; : ) { }` end it (outside URL context).
 */
const QUERY_FRAGMENT =
  /([?&])(?![.=])([^=&\s'"`#?<>]+)=(?!=)((?:\{\{[^{}]*\}\}|\([^()\s'"`]*\)|[^&\s'"`#{}()$;:])*)/g;
/** Where a URL value ends: `& # quote whitespace` or the end of the text. */
const URL_VALUE_END = /^(?:[&#'"`\s]|$)/;

function redactUserinfoInText(text: string, counter: Counter): string {
  return text.replace(USERINFO_IN_TEXT, (m, scheme: string, info: string) => {
    if (!info.includes(':') && USERNAME_SCHEMES.test(scheme)) return m;
    bump(counter);
    return `${scheme}://`;
  });
}

/** End of a URL-context value: the next `& # quote whitespace` or `${`. */
function urlValueEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text.charAt(i);
    if (URL_VALUE_END.test(c) || (c === '$' && text.charAt(i + 1) === '{')) break;
    i += 1;
  }
  return i;
}

/**
 * Credential-named `?k=v` / `&k=v` values. With URL context (a `/` earlier
 * in the same run — no whitespace or quote in between) the value runs to the
 * next `& # quote whitespace` or `${`. Without it, a value that ends at code
 * punctuation (`f(a?token=b)`, `e?key=t:n`, `` `?token=${t}` ``) is code and
 * kept; it is blanked when it ends where a URL can, or — for prose such as
 * `use ?token=S; then` — at `;` / `:` + whitespace after a whitespace-led `?`.
 */
function redactQueryFragments(text: string, counter: Counter): string {
  const re = new RegExp(QUERY_FRAGMENT.source, 'g');
  let scanned = 0;
  let urlContext = false;
  let out = '';
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const at = m.index;
    for (; scanned < at; scanned += 1) {
      const c = text.charAt(scanned);
      if (c === '/') urlContext = true;
      else if (/[\s'"`]/.test(c)) urlContext = false;
    }
    const sep = String(m[1]);
    const name = String(m[2]);
    const valueStart = at + sep.length + name.length + 1;
    let end = at + m[0].length;
    let literal: boolean;
    if (urlContext) {
      end = urlValueEnd(text, valueStart);
      literal = true;
    } else {
      const next = text.charAt(end);
      const prose =
        (next === ';' || next === ':') &&
        /^(?:\s|$)/.test(text.charAt(end + 1)) &&
        (at === 0 || /\s/.test(text.charAt(at - 1)));
      literal = URL_VALUE_END.test(next) || prose;
    }
    const value = text.slice(valueStart, end);
    if (!literal || !isSecretText(value) || !isSecretFieldName(decodeComponent(name))) continue;
    bump(counter);
    out += text.slice(last, valueStart);
    last = end;
    re.lastIndex = Math.max(re.lastIndex, end);
  }
  return out + text.slice(last);
}

/**
 * Credentials in a raw string value. A single-line value that starts with a
 * scheme is one URL and is redacted whole. Anything else is free text (a
 * script, a note): URL userinfo and credential-named `?k=v` / `&k=v` literals
 * are blanked in place; code (`x?.token==="a"`, `e?key=t:n`) is left alone.
 */
export function redactTextCredentials(value: string, counter: Counter): string {
  const body = value.trimStart();
  const lead = value.slice(0, value.length - body.length);
  if (SCHEME_START.test(body) && !body.includes('\n')) {
    if (counter) counter.n += countUrlStringSecrets(body);
    return lead + redactUrlCredentialsForStorage(body);
  }
  return redactQueryFragments(redactUserinfoInText(value, counter), counter);
}

/**
 * A header name followed by `:` inside text (boundary-anchored, so linear),
 * optionally glued to curl's `-H` (`-HAuthorization: …`).
 */
const HEADER_NAME_IN_TEXT = /(?<![A-Za-z0-9_-])(?:-H)?([A-Za-z][A-Za-z0-9_-]*):/g;
const HEADER_VALUE_END = `'"\n\r`;

/**
 * `<secret-header-name>: value` anywhere in a command line (`curl -H
 * 'Authorization: Bearer X'` however it is quoted or split): the value up to
 * the next quote / line break becomes one space. Each character is scanned once.
 */
function redactHeaderLinesInText(text: string, counter: Counter): string {
  const re = new RegExp(HEADER_NAME_IN_TEXT.source, 'g');
  let out = '';
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!isSecretFieldName(String(m[1]))) continue;
    const start = re.lastIndex;
    let end = start;
    while (end < text.length && !HEADER_VALUE_END.includes(text.charAt(end))) end += 1;
    if (!isSecretText(text.slice(start, end))) continue;
    bump(counter);
    out += `${text.slice(last, start)} `;
    last = end;
    re.lastIndex = end;
  }
  return out + text.slice(last);
}

// ── launch command lines (MCP stdio argv / command) ─────────────────────────

/** Characters a backslash escapes inside double quotes. */
const DQ_ESCAPABLE = `"'\\$\``;

/**
 * Split a command line into argv (whitespace, single / double quotes, and
 * POSIX backslash escapes inside double quotes). No shell. Used to show and
 * keep a launch shape; redaction never re-splits with it.
 */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  let escaped = false;
  for (const ch of line) {
    if (escaped) {
      cur += DQ_ESCAPABLE.includes(ch) ? ch : `\\${ch}`;
      escaped = false;
    } else if (quote === '"' && ch === '\\') {
      escaped = true;
    } else if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (escaped) cur += '\\';
  if (has || cur) out.push(cur);
  return out;
}

/** Short options whose value may be attached: `-pSECRET`, `-HName: v`, `-uuser:pass`. */
const ARG_ATTACHED = /^-([pHu])(.+)$/s;
const ARG_FLAG = /^--?([^=\s-][^=\s]*)$/;
const ARG_FLAG_ASSIGN = /^(--?)([^=\s]+)=(.*)$/s;
const ARG_ENV_ASSIGN = /^([A-Za-z_][A-Za-z0-9_.-]*)=(.*)$/s;

type ArgKind = 'secret' | 'header' | 'user' | 'plain';

function nameSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_.\s]+/)
    .map((s) => s.toLowerCase())
    .filter(Boolean);
}

/**
 * What an option / variable name says about its value: a header line
 * (`-H`, `--header`), `user:password` (`-u`, `--user`, `--proxy-user`), a
 * secret (`isSecretFieldName`, the short `-p`, any `pass` segment, a `pat`
 * suffix such as `--github-pat`), or nothing. `--port` stays plain.
 */
function argKind(name: string): ArgKind {
  const segs = nameSegments(name);
  const last = segs.at(-1);
  if (name === 'H' || last === 'header' || last === 'headers') return 'header';
  if (name === 'u' || last === 'user') return 'user';
  if (name === 'p' || isSecretFieldName(name) || segs.includes('pass') || last === 'pat') {
    return 'secret';
  }
  return 'plain';
}

function redactArgValue(kind: ArgKind, value: string, counter: Counter): string {
  if (kind === 'header') return redactHeaderLine(value, counter);
  if (kind === 'user') {
    const colon = value.indexOf(':');
    if (colon === -1 || !isSecretText(value.slice(colon + 1))) return value;
    bump(counter);
    return value.slice(0, colon + 1);
  }
  if (kind === 'secret') {
    if (!isSecretText(value)) return value;
    bump(counter);
    return '';
  }
  return redactArg(value, counter);
}

/**
 * A lone argument that is not an option value. One with whitespace (a nested
 * `sh -c "…"` line, a quoted value) gets the flat pass in place; anything
 * else is URL / text redacted. Flat-pass words have no whitespace, so this
 * never recurses more than once.
 */
function redactArg(arg: string, counter: Counter): string {
  return /\s/.test(arg) ? walkCommandLine(arg, counter) : redactTextCredentials(arg, counter);
}

/**
 * Blank credentials in a launch argv, element by element and in place: the
 * value after a secret / header / user option (`--token X`, `-H
 * "Authorization: Bearer X"`, `-u me:X`), the same in attached (`-pX`) and
 * `--opt=X` forms, `SECRET_KEY=X`, URL userinfo / credential query values,
 * and (flat pass) anything inside an element that contains whitespace. A
 * blanked element stays in place (`''`), so flag / value pairing is stable.
 */
export function walkArgv(argv: readonly unknown[], counter: Counter): unknown[] {
  let pending: ArgKind = 'plain';
  return argv.map((arg) => {
    if (typeof arg !== 'string') return arg;
    const kind = pending;
    pending = 'plain';
    if (kind !== 'plain' && !arg.startsWith('-')) return redactArgValue(kind, arg, counter);
    const attached = ARG_ATTACHED.exec(arg);
    if (attached) {
      const flag = String(attached[1]);
      const value = redactArgValue(argKind(flag), String(attached[2]), counter);
      // `-pX` → `-p*`, never a bare `-p` that would claim the next word on a re-walk.
      return `-${flag}${value === '' ? REDACTED_MASK : value}`;
    }
    const flag = ARG_FLAG.exec(arg);
    if (flag) {
      pending = argKind(String(flag[1]));
      return arg;
    }
    const assign = ARG_FLAG_ASSIGN.exec(arg) ?? ARG_ENV_ASSIGN.exec(arg);
    if (assign) {
      const value = String(assign.at(-1));
      const prefix = arg.slice(0, arg.length - value.length);
      return prefix + redactArgValue(argKind(String(assign.at(-2))), value, counter);
    }
    return redactArg(arg, counter);
  });
}

/** {@link walkArgv} for a display copy (the import report's argv). */
export function redactCommandArgv(argv: readonly string[]): string[] {
  return walkArgv(argv, undefined) as string[];
}

const EDGE_CHARS = `"'\\`;

/**
 * A command line (or a whitespace-containing argv element) with its
 * credentials blanked, by one quote-blind flat pass: secret header lines
 * anywhere in the text, then every whitespace-separated word with its edge
 * quotes / backslashes stripped walked as one flat argv (flag / value,
 * `--opt=X`, `KEY=X`, URL / text per word). Edits are made in place on the
 * original string — never re-quoted, re-joined, re-split or recursed — so
 * the work is linear, the output is never longer than the input, and a
 * blanked word stays a word (`''`, or `'` for a one-character value), which
 * keeps flag / value pairing and makes a second walk blank nothing.
 *
 * Best effort, not a shell parser: nested `sh -c` lines are covered because
 * their words are still words; a secret split across words with no
 * recognisable flag or header name can survive. The item is a disabled,
 * reference-only placeholder, so over-redaction is acceptable.
 */
export function walkCommandLine(line: string, counter: Counter): string {
  const local = { n: 0 };
  const text = redactHeaderLinesInText(line, local);
  const words: Array<{ start: number; end: number; lead: string; core: string; trail: string }> =
    [];
  for (const m of text.matchAll(/\S+/g)) {
    const word = m[0];
    let a = 0;
    while (a < word.length && EDGE_CHARS.includes(word.charAt(a))) a += 1;
    let b = word.length;
    while (b > a && EDGE_CHARS.includes(word.charAt(b - 1))) b -= 1;
    words.push({
      start: m.index,
      end: m.index + word.length,
      lead: word.slice(0, a),
      core: word.slice(a, b),
      trail: word.slice(b),
    });
  }
  const redacted = walkArgv(
    words.map((w) => w.core),
    local
  ) as string[];
  if (counter) counter.n += local.n;
  if (local.n === 0) return line;
  const out: string[] = [];
  let last = 0;
  words.forEach((w, i) => {
    const r = String(redacted[i]);
    if (r === w.core) return;
    let word = `${w.lead}${r}${w.trail}`;
    if (word === '') word = w.core.length > 1 ? "''" : "'";
    out.push(text.slice(last, w.start), word);
    last = w.end;
  });
  out.push(text.slice(last));
  return out.join('');
}
