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

const SCHEME_START = /^[a-z][a-z0-9+.-]*:\/\//i;
/** Userinfo inside text: only characters that cannot be in userinfo end it. */
const USERINFO_IN_TEXT = /([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi;
/** `?name=value` / `&name=value`, with or without a scheme; `{{ var }}` values stay whole. */
const QUERY_FRAGMENT = /([?&])([^=&\s'"`#?<>]+)=((?:\{\{[^{}]*\}\}|[^&\s'"`#{])*)/g;

/**
 * Credentials in a raw string value. A single-line value that starts with a
 * scheme is one URL and is redacted whole. Anything else is free text (a
 * script, a note): URL userinfo and credential-named `?k=v` / `&k=v`
 * fragments are blanked in place, so a `?` in a ternary / optional chain is
 * never read as a query string.
 */
export function redactTextCredentials(value: string, counter: Counter): string {
  const body = value.trimStart();
  const lead = value.slice(0, value.length - body.length);
  if (SCHEME_START.test(body) && !body.includes('\n')) {
    if (counter) counter.n += countUrlStringSecrets(body);
    return lead + redactUrlCredentialsForStorage(body);
  }
  return value
    .replace(USERINFO_IN_TEXT, (_m, scheme: string) => {
      bump(counter);
      return scheme;
    })
    .replace(QUERY_FRAGMENT, (m, sep: string, name: string, val: string) => {
      if (!isSecretText(val) || !isSecretFieldName(decodeComponent(name))) return m;
      bump(counter);
      return `${sep}${name}=`;
    });
}

// ── launch command lines (MCP stdio argv / command) ─────────────────────────

/** Split a command line into argv (whitespace, single / double quotes). No shell. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
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
  if (has || cur) out.push(cur);
  return out;
}

/** Nested `sh -c "..."` command lines are re-split up to this depth. */
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
  if (/\s/.test(arg) && depth < MAX_COMMAND_DEPTH) return walkCommandLine(arg, counter, depth + 1);
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

/** Quote an argument so {@link splitCommandLine} reads it back unchanged. */
function quoteArg(a: string): string {
  if (a !== '' && !/[\s'"]/.test(a)) return a;
  return a.includes("'") ? `"${a}"` : `'${a}'`;
}

/** A command line with its credential args blanked (re-quoted only when an arg changed). */
export function walkCommandLine(line: string, counter: Counter, depth = 0): string {
  const local = { n: 0 };
  const redacted = walkArgv(splitCommandLine(line), local, depth) as string[];
  if (local.n === 0) return line;
  if (counter) counter.n += local.n;
  return redacted.map(quoteArg).join(' ');
}
