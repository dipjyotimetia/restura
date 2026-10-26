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
// anything that needs left context is tracked by one forward scan.
const SCHEME_START = /^[a-z][a-z0-9+.-]*:\/\//i;
/** `scheme://userinfo@` inside text; the whole userinfo goes (as on the whole-URL path). */
const USERINFO_IN_TEXT = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*):\/\/([^\s/?#@]+)@/gi;
/** Schemes whose username is an account name, not a credential (`ssh://deploy@host`). */
const USERNAME_SCHEMES = /^(?:ssh|git|sftp|scp|rsync|git\+ssh|ssh\+git|svn\+ssh)$/i;
/**
 * `?name=value` / `&name=value`, with or without a scheme. Not after `?.`
 * (optional chaining) and not `==` (comparison); `{{ var }}` and a balanced
 * `( … )` stay inside the value; `$ ; : ) { }` end it.
 */
const QUERY_FRAGMENT =
  /([?&])(?![.=])([^=&\s'"`#?<>]+)=(?!=)((?:\{\{[^{}]*\}\}|\([^()\s'"`]*\)|[^&\s'"`#{}()$;:])*)/g;
/** The value ends where a URL can: `& # quote whitespace` or the end. */
const URL_VALUE_END = /^(?:[&#'"`\s]|$)/;
/** The value ends at sentence punctuation (`?token=X; then`), not code (`e?k=t:n`). */
const PROSE_VALUE_END = /^[{}()$;:](?:\s|$)/;

function redactUserinfoInText(text: string, counter: Counter): string {
  return text.replace(USERINFO_IN_TEXT, (m, scheme: string, info: string) => {
    if (!info.includes(':') && USERNAME_SCHEMES.test(scheme)) return m;
    bump(counter);
    return `${scheme}://`;
  });
}

/**
 * Credential-named `?k=v` / `&k=v` values. With URL context (a `/` earlier
 * in the same run — no whitespace or quote in between) the literal prefix is
 * blanked up to any terminator. Without it the value must end where a URL or
 * a sentence can, so code (`e?key=t:n`, `` `?token=${t}` ``) is left alone.
 */
function redactQueryFragments(text: string, counter: Counter): string {
  let scanned = 0;
  let urlContext = false;
  return text.replace(QUERY_FRAGMENT, (m, sep: string, name: string, val: string, at: number) => {
    for (; scanned < at; scanned += 1) {
      const c = text.charAt(scanned);
      if (c === '/') urlContext = true;
      else if (/[\s'"`]/.test(c)) urlContext = false;
    }
    const after = text.slice(at + m.length, at + m.length + 2);
    const literal =
      urlContext || URL_VALUE_END.test(after.charAt(0)) || PROSE_VALUE_END.test(after);
    if (!literal || !isSecretText(val) || !isSecretFieldName(decodeComponent(name))) return m;
    bump(counter);
    return `${sep}${name}=`;
  });
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

/** A header name followed by `:` inside text (boundary-anchored, so linear). */
const HEADER_NAME_IN_TEXT = /(?<![A-Za-z0-9_-])([A-Za-z][A-Za-z0-9_-]*):/g;
const HEADER_VALUE_END = `'"\n\r`;

/**
 * `<secret-header-name>: value` anywhere in a command line (`curl -H
 * 'Authorization: Bearer X'` however it is quoted or split): the value up to
 * the next quote / line break is blanked. Each character is scanned once.
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
 * POSIX backslash escapes inside double quotes). No shell.
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

/** Nested `sh -c "..."` command lines are re-split (shell-style) up to this depth. */
const MAX_COMMAND_DEPTH = 3;
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

function redactArgValue(kind: ArgKind, value: string, counter: Counter, depth: number): string {
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
  return redactArg(value, counter, depth);
}

/** A lone argument that is not an option value: nested command line, URL or text. */
function redactArg(arg: string, counter: Counter, depth: number): string {
  if (/\s/.test(arg) && depth <= MAX_COMMAND_DEPTH) {
    return walkCommandLine(arg, counter, depth + 1);
  }
  return redactTextCredentials(arg, counter);
}

/**
 * Blank credentials in a launch argv: the value after a secret / header /
 * user option (`--token X`, `-H "Authorization: Bearer X"`, `-u me:X`), the
 * same in attached (`-pX`, `-HAuthorization: X`) and `--opt=X` forms,
 * `SECRET_KEY=X`, URL userinfo / credential query values anywhere, and the
 * same inside nested command lines (`sh -c "..."`). `{{var}}` is kept.
 */
export function walkArgv(argv: readonly unknown[], counter: Counter, depth = 0): unknown[] {
  let pending: ArgKind = 'plain';
  return argv.map((arg) => {
    if (typeof arg !== 'string') return arg;
    const kind = pending;
    pending = 'plain';
    if (kind !== 'plain' && !arg.startsWith('-')) return redactArgValue(kind, arg, counter, depth);
    const attached = ARG_ATTACHED.exec(arg);
    if (attached) {
      const flag = String(attached[1]);
      return `-${flag}${redactArgValue(argKind(flag), String(attached[2]), counter, depth)}`;
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
      return prefix + redactArgValue(argKind(String(assign.at(-2))), value, counter, depth);
    }
    return redactArg(arg, counter, depth);
  });
}

/** {@link walkArgv} for a display copy (the import report's argv). */
export function redactCommandArgv(argv: readonly string[]): string[] {
  return walkArgv(argv, undefined) as string[];
}

/**
 * Quote an argument so {@link splitCommandLine} reads it back unchanged
 * (single quotes; an embedded `'` becomes the adjacent segment `"'"`).
 */
function quoteArg(a: string): string {
  if (a !== '' && !/[\s'"\\]/.test(a)) return a;
  return `'${a.replaceAll("'", `'"'"'`)}'`;
}

interface Pass {
  text: string;
  n: number;
}

/** Shell-style split, nested lines walked recursively (bounded by the depth cap). */
function strictPass(line: string, depth: number): Pass {
  const local = { n: 0 };
  const redacted = walkArgv(splitCommandLine(line), local, depth) as string[];
  if (local.n === 0) return { text: line, n: 0 };
  return { text: redacted.map(quoteArg).join(' '), n: local.n };
}

const EDGE_CHARS = `"'\\`;

/**
 * Quote-blind pass: secret header lines anywhere in the text, then every
 * whitespace-separated word with its edge quotes / backslashes stripped
 * walked as one flat argv (flag / value, `--opt=X`, `KEY=X`). Words are
 * never re-joined or re-split, and the edits are made in place, so the work
 * is linear and the line's structure survives.
 */
function flatPass(line: string): Pass {
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
    const start = m.index;
    words.push({
      start,
      end: start + word.length,
      lead: word.slice(0, a),
      core: word.slice(a, b),
      trail: word.slice(b),
    });
  }
  const redacted = walkArgv(
    words.map((w) => w.core),
    local,
    MAX_COMMAND_DEPTH + 1
  ) as string[];
  if (local.n === 0) return { text: line, n: 0 };
  const out: string[] = [];
  let last = 0;
  words.forEach((w, i) => {
    const r = String(redacted[i]);
    if (r === w.core) return;
    // A blanked word stays a word (`''`), so a re-walk pairs flags and values the same way.
    const word = `${w.lead}${r}${w.trail}`;
    out.push(text.slice(last, w.start), word === '' ? "''" : word);
    last = w.end;
  });
  out.push(text.slice(last));
  return { text: out.join(''), n: local.n };
}

/**
 * A command line with its credential args blanked. Up to the nesting cap
 * both a shell-style pass (nested `sh -c` lines walked recursively) and a
 * quote-blind flat pass run, and the one that blanks more wins (ties: shell
 * style); count and redact modes make the same choice, so the count equals
 * what is blanked. Past the cap only the flat pass runs. This is best effort
 * against what a shell would do, not a shell parser: secrets the flat pass
 * cannot see (e.g. a value split across words with no recognisable flag or
 * header name) can survive.
 */
function walkCommandLineOnce(line: string, counter: Counter, depth: number): string {
  const flat = flatPass(line);
  let best = flat;
  if (depth <= MAX_COMMAND_DEPTH) {
    const strict = strictPass(line, depth);
    if (strict.n >= flat.n) best = strict;
  }
  if (counter) counter.n += best.n;
  return best.text;
}

/** Re-walk rounds at the outer levels, so a quote-confused line settles (bounded). */
const FIXPOINT_ROUNDS = 4;
const FIXPOINT_MAX_DEPTH = 1;

/**
 * {@link walkCommandLineOnce}, repeated at the outer levels until a round
 * blanks nothing: a shell-style re-parse of a quote-confused, already
 * redacted line can pair a flag with a different word, and the stored text
 * must not count again on export. Count and redact modes run the same rounds.
 */
export function walkCommandLine(line: string, counter: Counter, depth = 0): string {
  if (depth > FIXPOINT_MAX_DEPTH) return walkCommandLineOnce(line, counter, depth);
  let text = line;
  for (let round = 0; round < FIXPOINT_ROUNDS; round += 1) {
    const local = { n: 0 };
    const next = walkCommandLineOnce(text, local, depth);
    if (local.n === 0) break;
    if (counter) counter.n += local.n;
    text = next;
  }
  return text;
}
