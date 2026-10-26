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

function isSecretText(value: string): boolean {
  const v = value.trim();
  return v !== '' && !SINGLE_VARIABLE_REFERENCE.test(v);
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
  return isBlank(value) || SINGLE_VARIABLE_REFERENCE.test(value.trim());
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
