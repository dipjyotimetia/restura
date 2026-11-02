import { isSecretFieldName, isSecretVariableName } from '../../secrets/key-value-redaction';

/**
 * String-level credential redaction for the `_postman` sidecar (ADR 0034):
 * URLs, header lines, free text (scripts, notes) and launch command lines
 * (MCP stdio `argv` / `command`). Every function both redacts and counts
 * (`counter` defined = count mode) from the same code path, so the export
 * count always equals what redaction blanks. Leaf module: `./redaction.ts`
 * builds on it, never the other way round.
 */

export type Counter = { n: number } | undefined;

/**
 * A value made only of `{{name}}` references, `:` and whitespace: pointers, not
 * secrets. Names follow `shared/variables/tokens.ts` (`{{my key}}`, no line break,
 * not blank). Any literal character outside a reference fails it.
 */
export const REFERENCE_ONLY_VALUE = /^\s*(?:\{\{(?!\s*\}\})[^{}\r\n\u2028\u2029]+\}\}[\s:]*)+$/;

function isSecretText(value: string): boolean {
  const v = value.trim();
  return v !== '' && !REFERENCE_ONLY_VALUE.test(v);
}

function bump(counter: Counter): void {
  if (counter) counter.n += 1;
}

// ── URLs: the one authority ─────────────────────────────────────────────────
//
// `scanUrlCredentials` is the single rule for credentials in a URL string, used
// by export slots, passthrough bags, MCP tool output, the console and generated
// docs. It normalises first, as the WHATWG parser does, then classifies. Nothing
// else parses URLs for credentials: a new surface calls this.

/**
 * What comes before the authority. A special scheme takes any number of slashes,
 * including none, as the WHATWG parser does (`https:///u:p@h`, `https:u:p@h`); a
 * templated scheme may be special, so it takes extra ones. Other schemes need `//`,
 * and may be compound (`jdbc:mysql://`, `view-source:https://`).
 */
const URL_PREFIX =
  /^(?:(?:https?|wss?|ftp):[\\/]*|\{\{[^{}]*\}\}:\/\/+|(?:[a-z][a-z0-9+.-]*:)*\/\/)/i;
/** No authority without `//`, so a `:` and `@` are not userinfo. */
const NON_HIERARCHICAL_SCHEME = /^(?:mailto|data|tel|sms|urn|sips?|xmpp|acct):(?!\/\/)/i;
const VARIABLE_REFERENCE = /\{\{(?!\s*\}\})[^{}\r\n\u2028\u2029]+\}\}/g;
const IPV6_LITERAL = /^\[[^\]]*\]/;
const PORT = /^\d*$/;
/** A free-form value is only touched when all of it is a URL with a scheme and `//`. */
const WHOLE_URL_VALUE = /^(?:(?:[a-z][a-z0-9+.-]*|\{\{[^{}]*\}\}):)+\/\/[^\s"'`]*$/i;
/** Schemes whose username is an account name, not a credential (`ssh://deploy@host`). */
const USERNAME_SCHEMES = /^(?:ssh|git|sftp|scp|rsync|git\+ssh|ssh\+git|svn\+ssh)$/i;
/** Userinfo passes before giving up on reading the rest; only hostile input gets there. */
const MAX_USERINFO_PASSES = 4;

export interface UrlScanOptions {
  /** Replaces a credential query value. Default: blank. */
  mask?: string;
  /** Replaces userinfo, as `<mask>@`, for a display that shows it was there. Default: removed. */
  userinfoMask?: string;
  /** Names to treat as credentials. Default: {@link isSecretFieldName}. */
  isSecretParam?: (name: string) => boolean;
  /** The string may be any text, not a known address: see {@link WHOLE_URL_VALUE}. */
  anyText?: boolean;
}

/** Userinfo made only of `{{var}}` references (and `:`): pointers, not secrets. */
export function isReferenceOnlyUserinfo(userinfo: string): boolean {
  return userinfo.replace(VARIABLE_REFERENCE, '').replace(/:/g, '') === '';
}

function isC0OrSpace(code: number): boolean {
  return code <= 0x20;
}

/** Strip what the WHATWG parser strips: outer C0 / space, and any tab or newline. */
function normalizeUrlInput(url: string): string {
  const text = url.replace(/[\t\n\r]/g, '');
  let start = 0;
  let end = text.length;
  while (start < end && isC0OrSpace(text.charCodeAt(start))) start += 1;
  while (end > start && isC0OrSpace(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/**
 * True when the `:` in a reference-masked authority cannot introduce a port, so
 * a delimiter ended a password early. A reference reads as a port digit.
 */
function hasNonPortColon(authority: string): boolean {
  const plain = authority.replace(IPV6_LITERAL, '');
  const colon = plain.indexOf(':');
  return colon !== -1 && !PORT.test(plain.slice(colon + 1));
}

function maskReferences(text: string): string {
  return text.replace(VARIABLE_REFERENCE, (reference) => '0'.repeat(reference.length));
}

/** The last scheme of a `scheme://` prefix (`git+ssh`, `https` of `view-source:https://`). */
function prefixScheme(prefix: string): string {
  const slashes = prefix.indexOf('//');
  if (slashes < 1) return '';
  const schemes = prefix.slice(0, slashes - 1);
  return schemes.slice(schemes.lastIndexOf(':') + 1);
}

/** The next userinfo in `url`, or null. References are never read as delimiters. */
function nextUserinfo(url: string): { userinfo: string; remainder: string } | null {
  if (!url.includes('@') || NON_HIERARCHICAL_SCHEME.test(url)) return null;
  const prefix = URL_PREFIX.exec(url)?.[0] ?? '';
  const rest = url.slice(prefix.length);
  const masked = maskReferences(rest);
  const pathStart = masked.search(/[/?#]/);
  const authority = pathStart === -1 ? masked : masked.slice(0, pathStart);
  let at = authority.lastIndexOf('@');
  if (at === -1) {
    // A password holding a delimiter. Without `//` this shape is an ordinary value.
    if (prefix === '' || !hasNonPortColon(authority)) return null;
    const queryStart = masked.search(/[?#]/);
    at = queryStart === -1 ? -1 : masked.slice(0, queryStart).lastIndexOf('@');
    if (at === -1) at = masked.lastIndexOf('@');
    if (at === -1) return null;
  } else if (!masked.slice(0, at).includes(':') && USERNAME_SCHEMES.test(prefixScheme(prefix))) {
    return null;
  }
  return { userinfo: rest.slice(0, at), remainder: `${prefix}${rest.slice(at + 1)}` };
}

/**
 * Userinfo through the last `@` of the authority, for an optional scheme. Each
 * pass is linear and there are at most {@link MAX_USERINFO_PASSES}; past that,
 * everything through the last `@` goes. Reference-only userinfo stays unless what
 * follows it had a credential too.
 */
function stripUrlUserinfo(url: string): string {
  let result = url;
  let probe = url;
  for (let pass = 0; pass < MAX_USERINFO_PASSES; pass += 1) {
    const found = nextUserinfo(probe);
    if (!found) return result;
    probe = found.remainder;
    if (!isReferenceOnlyUserinfo(found.userinfo)) result = probe;
  }
  const prefix = URL_PREFIX.exec(probe)?.[0] ?? '';
  const rest = probe.slice(prefix.length);
  const lastAt = maskReferences(rest).lastIndexOf('@');
  return lastAt === -1 ? result : `${prefix}${rest.slice(lastAt + 1)}`;
}

function decodeComponent(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

function looksLikeUrl(text: string): boolean {
  return text.startsWith('//') || text.includes('://');
}

/** One `name=value`. A value that is a URL is read once, never recursively. */
function redactUrlParam(pair: string, options: UrlScanOptions, readNested: boolean): string {
  const eq = pair.indexOf('=');
  if (eq === -1) return pair;
  const rawName = pair.slice(0, eq);
  const value = pair.slice(eq + 1);
  if (!value) return pair;
  const decoded = decodeComponent(value);
  if (REFERENCE_ONLY_VALUE.test(decoded.trim())) return pair;
  const isSecretParam = options.isSecretParam ?? isSecretFieldName;
  if (isSecretParam(decodeComponent(rawName))) return `${rawName}=${options.mask ?? ''}`;
  if (!readNested || !looksLikeUrl(decoded)) return pair;
  const inner = scan(decoded, options, false);
  if (inner.edits === 0) return pair;
  if (decoded === value) return `${rawName}=${inner.redacted}`;
  try {
    return `${rawName}=${encodeURIComponent(inner.redacted)}`;
  } catch {
    // A lone surrogate cannot be encoded: the value goes, like a credential.
    return `${rawName}=${options.mask ?? ''}`;
  }
}

function redactUrlParamList(
  list: string,
  options: UrlScanOptions,
  readNested: boolean
): { text: string; edits: number } {
  let edits = 0;
  const text = list
    .split('&')
    .map((pair) => {
      const next = redactUrlParam(pair, options, readNested);
      if (next !== pair) edits += 1;
      return next;
    })
    .join('&');
  return { text, edits };
}

/** Query and fragment parameters (`#access_token=`, `#/route?token=`). */
function redactUrlParams(
  url: string,
  options: UrlScanOptions,
  readNested: boolean
): { text: string; edits: number } {
  const hash = url.indexOf('#');
  const base = hash === -1 ? url : url.slice(0, hash);
  const query = base.indexOf('?');
  let edits = 0;
  let text = base;
  if (query !== -1) {
    const params = redactUrlParamList(base.slice(query + 1), options, readNested);
    edits += params.edits;
    text = `${base.slice(0, query + 1)}${params.text}`;
  }
  if (hash === -1) return { text, edits };
  const fragment = url.slice(hash + 1);
  const start = fragment.indexOf('?') + 1;
  const params = redactUrlParamList(fragment.slice(start), options, readNested);
  return {
    text: `${text}#${fragment.slice(0, start)}${params.text}`,
    edits: edits + params.edits,
  };
}

function scan(
  url: string,
  options: UrlScanOptions,
  readNested: boolean
): { redacted: string; edits: number } {
  if (options.anyText && !WHOLE_URL_VALUE.test(url.trim())) return { redacted: url, edits: 0 };
  const input = normalizeUrlInput(url);
  if (!/[@?#]/.test(input)) return { redacted: url, edits: 0 };
  let stripped = stripUrlUserinfo(input);
  const userinfoEdits = stripped === input ? 0 : 1;
  if (userinfoEdits === 1 && options.userinfoMask !== undefined) {
    const prefix = URL_PREFIX.exec(stripped)?.[0] ?? '';
    stripped = `${prefix}${options.userinfoMask}@${stripped.slice(prefix.length)}`;
  }
  const params = redactUrlParams(stripped, options, readNested);
  const edits = userinfoEdits + params.edits;
  // A string with no credential comes back exactly as written.
  return edits === 0 ? { redacted: url, edits: 0 } : { redacted: params.text, edits };
}

/** {@link scan} with the one level of nested URL reading. */
export function scanUrlCredentials(
  url: string,
  options: UrlScanOptions = {}
): { redacted: string; edits: number } {
  return scan(url, options, true);
}

/**
 * Credentials in a URL string removed; templated URLs survive apart from the
 * credential, and userinfo or a value made only of `{{var}}` references is kept.
 * Lives in this leaf module because `shared/secrets/mcp-credential-redaction.ts`
 * depends on collection-redaction, which depends on `./redaction.ts` (runtime cycle).
 */
export function redactUrlCredentialsForStorage(url: string): string {
  return scanUrlCredentials(url).redacted;
}

/** Exactly the number of edits {@link redactUrlCredentialsForStorage} makes to `url`. */
export function countUrlStringSecrets(url: string): number {
  return scanUrlCredentials(url).edits;
}

/**
 * A value that may or may not be a URL (a variable): credentials are removed only
 * when all of it is a URL with a scheme and `//`. Anything else comes back as written.
 */
export function redactTextValueCredentials(value: string): string {
  return scanUrlCredentials(value, { anyText: true }).redacted;
}

/**
 * The one policy for a variable's value: a credential-named value is replaced with
 * `mask`, a value made only of references stays, and a whole URL loses its credentials.
 */
export function redactVariableValue(name: string, value: string, mask = ''): string {
  if (!value || REFERENCE_ONLY_VALUE.test(value.trim())) return value;
  return isSecretVariableName(name) ? mask : redactTextValueCredentials(value);
}

const URL_HEADER_NAMES = new Set(['location', 'content-location', 'referer']);

/** A header whose value is a URL. */
export function isUrlHeaderName(name: string): boolean {
  return URL_HEADER_NAMES.has(name.trim().toLowerCase());
}

// ── header lines ────────────────────────────────────────────────────────────

const HEADER_LINE = /^([^:]+):(.*)$/s;

/** `Name: value` where the name is a credential and the value a plaintext secret. */
export function isSecretHeaderLine(line: string): boolean {
  const m = HEADER_LINE.exec(line);
  return !!m && isSecretFieldName(String(m[1]).trim()) && isSecretText(String(m[2]));
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
  // URL-context value end, memoized: every value start before it ends there
  // too, so a run of non-terminated fragments is scanned once (linear).
  let urlEnd = -1;
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
    // Cheap name check first: a non-credential name never triggers a value scan.
    if (!isSecretFieldName(decodeComponent(name))) continue;
    const valueStart = at + sep.length + name.length + 1;
    let end = at + m[0].length;
    let literal: boolean;
    if (urlContext) {
      if (valueStart >= urlEnd) urlEnd = urlValueEnd(text, valueStart);
      end = urlEnd;
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
    if (!literal || !isSecretText(value)) continue;
    bump(counter);
    out += text.slice(last, valueStart);
    last = end;
    re.lastIndex = Math.max(re.lastIndex, end);
  }
  return out + text.slice(last);
}

/**
 * Credentials in a raw string value. A single-line value that starts with a
 * scheme is redacted as one URL first. Every value is then treated as free text
 * (a script, a note), so a later URL on the same line is still covered: URL
 * userinfo and credential-named `?k=v` / `&k=v` literals are blanked in place,
 * and code (`x?.token==="a"`, `e?key=t:n`) is left alone. The free-text pass
 * sees the already-redacted URL, so nothing is blanked or counted twice.
 */
export function redactTextCredentials(value: string, counter: Counter): string {
  const body = value.trimStart();
  const lead = value.slice(0, value.length - body.length);
  let text = value;
  if (SCHEME_START.test(body) && !body.includes('\n')) {
    if (counter) counter.n += countUrlStringSecrets(body);
    text = lead + redactUrlCredentialsForStorage(body);
  }
  return redactQueryFragments(redactUserinfoInText(text, counter), counter);
}

// ── launch command lines (MCP stdio argv / command) ─────────────────────────
//
// FAIL CLOSED (#1210): an imported launch line keeps only its shape. The
// executable (URL / userinfo redacted), option NAMES and `{{var}}` words
// survive; every argument value — positional, after a flag, glued
// (`--opt=V`, `-XV`), `KEY=V`, quoted spans, nested `sh -c` payloads — is
// blanked. No guessing which values are secret. Edits are in place, never
// longer than the input, linear, and a blanked word stays word-shaped, so a
// second walk blanks nothing (count == blanked, count(redact(x)) == 0).

/** Characters a backslash escapes inside double quotes. */
const DQ_ESCAPABLE = `"'\\$\``;

/**
 * Split a command line into argv (whitespace, single / double quotes, and
 * POSIX backslash escapes inside double quotes). No shell. Used to keep the
 * launch shape (`argv`); redaction never re-splits with it.
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

/** `KEY=` of an environment assignment. */
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** `--name` / `--name=` (the value, if any, follows). */
const LONG_FLAG = /^--[A-Za-z0-9][A-Za-z0-9_.-]*=?/;
/** `-X` (a short option; anything glued after it is a value). */
const SHORT_FLAG = /^-[A-Za-z0-9]/;

/** Already blanked (or empty): `''`, `""`, a `*` mask, or nothing at all. */
function isBlank(value: string): boolean {
  return value === '' || value === "''" || value === '""' || /^\*+$/.test(value);
}

/** A value that is kept: empty / already blanked, or a lone `{{var}}`. */
function isKept(value: string): boolean {
  return isBlank(value) || REFERENCE_ONLY_VALUE.test(value.trim());
}

/**
 * One word (a command-line word, or an argv element) under the fail-closed
 * policy. `blankWord` is what a whole blanked word becomes (`''` / `*` in a
 * command line, so it stays a word; `''` in argv). Returns the new word.
 */
function redactWord(
  word: string,
  exec: boolean,
  counter: Counter,
  blankWord: (w: string) => string
): string {
  const keep = (prefix: string): string => {
    const value = word.slice(prefix.length);
    if (isKept(value)) return word;
    bump(counter);
    return prefix;
  };
  const env = ENV_ASSIGN.exec(word);
  if (env) return keep(env[0]);
  const long = LONG_FLAG.exec(word);
  if (long) return keep(long[0]);
  const short = SHORT_FLAG.exec(word);
  if (short) return keep(short[0]);
  if (word === '-' || word === '--' || isKept(word)) return word;
  if (exec) return redactTextCredentials(word, counter);
  bump(counter);
  return blankWord(word);
}

/**
 * True for the words that can be the executable: not `KEY=V`, not an option,
 * and no whitespace or quotes (a quoted span is a value: fail closed).
 */
function canBeExec(word: string): boolean {
  return !word.startsWith('-') && !/[\s'"]/.test(word);
}

/**
 * The executable slot: the FIRST word that is not `KEY=V` — whether or not
 * it qualifies (an empty / quoted / option first word uses the slot up and is
 * blanked or handled as an option). Never promotes a later word, so command
 * and argv agree and a re-walk of `['', '']` blanks nothing.
 */
function execSlot(): (word: string) => boolean {
  let used = false;
  return (word) => {
    if (used || ENV_ASSIGN.test(word)) return false;
    used = true;
    return canBeExec(word);
  };
}

/**
 * An argv under the fail-closed policy, element by element and in place:
 * the executable slot (see {@link execSlot}) keeps a qualifying executable;
 * options keep their names; every value becomes `''`.
 */
export function walkArgv(argv: readonly unknown[], counter: Counter): unknown[] {
  const isExec = execSlot();
  return argv.map((arg) => {
    if (typeof arg !== 'string') return arg;
    return redactWord(arg, isExec(arg), counter, () => '');
  });
}

/** {@link walkArgv} for a display copy (the import report's argv). */
export function redactCommandArgv(argv: readonly string[]): string[] {
  return walkArgv(argv, undefined) as string[];
}

/** Index just past the quote that closes the one at `open` (or the end). */
function closeQuote(line: string, open: number): number {
  const q = line.charAt(open);
  let k = open + 1;
  while (k < line.length) {
    const c = line.charAt(k);
    if (q === '"' && c === '\\') k += 2;
    else if (c === q) return k + 1;
    else k += 1;
  }
  return line.length;
}

/** End of the word starting at `i`: whitespace ends it, a quoted span runs to its close. */
function wordEnd(line: string, i: number): number {
  let j = i;
  while (j < line.length && !/\s/.test(line.charAt(j))) {
    const c = line.charAt(j);
    if (c === '"' || c === "'") j = closeQuote(line, j);
    else if (c === '\\') j += 2;
    else j += 1;
  }
  return Math.min(j, line.length);
}

/**
 * A launch command line under the fail-closed policy, edited in place: words
 * are found once (a quoted span — `"S TAIL"`, a nested `sh -c '…'` payload —
 * is one word through its closing quote), each goes through
 * {@link redactWord}, and a blanked word becomes `''` (or `*` for a
 * one-character word) so the output is never longer than the input.
 */
export function walkCommandLine(line: string, counter: Counter): string {
  const out: string[] = [];
  let last = 0;
  const isExec = execSlot();
  let i = 0;
  while (i < line.length) {
    if (/\s/.test(line.charAt(i))) {
      i += 1;
      continue;
    }
    const end = wordEnd(line, i);
    const word = line.slice(i, end);
    const next = redactWord(word, isExec(word), counter, (w) => (w.length > 1 ? "''" : '*'));
    if (next !== word) {
      out.push(line.slice(last, i), next);
      last = end;
    }
    i = end;
  }
  if (last === 0) return line;
  out.push(line.slice(last));
  return out.join('');
}
