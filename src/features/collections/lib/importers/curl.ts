import { v4 as uuid } from 'uuid';
import type { AuthConfig, HttpRequest, KeyValue, ProxyConfig, RequestSettings } from '@/types';
import { coerceHttpMethod, type ImportResult, type ImportWarning } from './types';

const SHELL_OPERATORS = new Set([';', '|', '||', '&&', '&']);

/** curl's single-letter options, by the long name they alias (curl(1)). */
const SHORT_OPTIONS: Readonly<Record<string, string>> = {
  '0': 'http1.0',
  '1': 'tlsv1',
  '2': 'sslv2',
  '3': 'sslv3',
  '4': 'ipv4',
  '6': 'ipv6',
  '#': 'progress-bar',
  a: 'append',
  A: 'user-agent',
  b: 'cookie',
  B: 'use-ascii',
  c: 'cookie-jar',
  C: 'continue-at',
  d: 'data',
  D: 'dump-header',
  e: 'referer',
  E: 'cert',
  f: 'fail',
  F: 'form',
  g: 'globoff',
  G: 'get',
  h: 'help',
  H: 'header',
  i: 'include',
  I: 'head',
  j: 'junk-session-cookies',
  J: 'remote-header-name',
  k: 'insecure',
  K: 'config',
  l: 'list-only',
  L: 'location',
  m: 'max-time',
  M: 'manual',
  n: 'netrc',
  N: 'no-buffer',
  o: 'output',
  O: 'remote-name',
  p: 'proxytunnel',
  P: 'ftp-port',
  q: 'disable',
  Q: 'quote',
  r: 'range',
  R: 'remote-time',
  s: 'silent',
  S: 'show-error',
  t: 'telnet-option',
  T: 'upload-file',
  u: 'user',
  U: 'proxy-user',
  v: 'verbose',
  V: 'version',
  w: 'write-out',
  x: 'proxy',
  X: 'request',
  y: 'speed-time',
  Y: 'speed-limit',
  z: 'time-cond',
  Z: 'parallel',
};

/**
 * Long options that consume an argument (curl(1)). An option missing from this
 * table is read as a boolean switch, so a value-taking option missing here
 * would leave its value to be taken for the URL — keep the table broad.
 */
const VALUE_OPTIONS: ReadonlySet<string> = new Set(
  `abstract-unix-socket alt-svc aws-sigv4 cacert capath cert cert-type ciphers config
  connect-timeout connect-to continue-at cookie cookie-jar create-file-mode crlfile curves data
  data-ascii data-binary data-raw data-urlencode delegation dns-interface dns-ipv4-addr
  dns-ipv6-addr dns-servers doh-url dump-header ech egd-file engine etag-compare etag-save
  expect100-timeout form form-string ftp-account ftp-alternative-to-user ftp-method ftp-port
  ftp-ssl-ccc-mode happy-eyeballs-timeout-ms haproxy-clientip header hostpubmd5 hostpubsha256
  hsts interface ip-tos ipfs-gateway json keepalive-cnt keepalive-time key key-type krb krb4
  libcurl limit-rate local-port login-options mail-auth mail-from mail-rcpt max-filesize
  max-redirs max-time netrc-file noproxy oauth2-bearer output output-dir parallel-max pass
  pinnedpubkey preproxy proto proto-default proto-redir proxy proxy-cacert proxy-capath
  proxy-cert proxy-cert-type proxy-ciphers proxy-crlfile proxy-header proxy-key proxy-key-type
  proxy-pass proxy-pinnedpubkey proxy-service-name proxy-tls13-ciphers proxy-tlsauthtype
  proxy-tlspassword proxy-tlsuser proxy-user proxy1.0 pubkey quote random-file range rate
  referer request request-target resolve retry retry-delay retry-max-time sasl-authzid
  service-name sigalgs socks4 socks4a socks5 socks5-gssapi-service socks5-hostname speed-limit
  speed-time ssl-sessions stderr telnet-option tftp-blksize time-cond tls-max tls13-ciphers
  tlsauthtype tlspassword tlsuser trace trace-ascii trace-config unix-socket upload-file url
  url-query user user-agent variable write-out`.split(/\s+/)
);

/**
 * Options that only shape curl's own output or local bookkeeping. They carry no
 * request semantics, so dropping them is lossless and needs no warning.
 * (`--compressed` is not here: it is noted as an unsupported-option warning —
 * the transports negotiate and decode compression themselves.)
 */
const IGNORED_OPTIONS: ReadonlySet<string> = new Set(
  `create-dirs dump-header fail fail-early fail-with-body globoff include libcurl
  no-buffer no-progress-meter output output-dir progress-bar remote-header-name remote-name
  remote-name-all show-error silent stderr styled-output no-styled-output trace trace-ascii
  trace-config trace-time verbose write-out`.split(/\s+/)
);

/** Options whose value names a local file that is never read. */
const FILE_OPTIONS: ReadonlySet<string> = new Set(
  `cacert capath cert config cookie-jar crlfile key netrc-file proxy-cacert proxy-capath
  proxy-cert proxy-crlfile proxy-key`.split(/\s+/)
);

interface ParsedOption {
  /** The option as written (`-d`, `--data`), for warnings. */
  flag: string;
  /** curl's long option name (`data`). */
  name: string;
  value?: string;
}

/**
 * Split lexed words into options and positional URLs the way curl does:
 * clustered short switches (`-sSL`), attached short values (`-XPOST`,
 * `-HAccept:x`, `-dfoo`), and — leniently — `--long=value`.
 */
function parseArgs(tokens: readonly string[]): { options: ParsedOption[]; urls: string[] } {
  const options: ParsedOption[] = [];
  const urls: string[] = [];
  const next = (index: number, flag: string): string => {
    const value = tokens[index + 1];
    // An empty quoted argument (`-d ''`) is a real, empty value.
    if (value === undefined) throw new Error(`cURL option ${flag} requires a value.`);
    return value;
  };

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    if (token === '--') {
      urls.push(...tokens.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const equal = token.indexOf('=');
      const attachedName = equal === -1 ? undefined : token.slice(2, equal);
      if (attachedName !== undefined && VALUE_OPTIONS.has(attachedName)) {
        options.push({
          flag: `--${attachedName}`,
          name: attachedName,
          value: token.slice(equal + 1),
        });
        continue;
      }
      const name = token.slice(2);
      if (VALUE_OPTIONS.has(name)) {
        options.push({ flag: token, name, value: next(i, token) });
        i++;
      } else {
        options.push({ flag: token, name });
      }
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      for (let j = 1; j < token.length; j++) {
        const letter = token.charAt(j);
        const flag = `-${letter}`;
        const name = SHORT_OPTIONS[letter];
        if (!name) {
          options.push({ flag, name: flag });
          continue;
        }
        if (!VALUE_OPTIONS.has(name)) {
          options.push({ flag, name });
          continue;
        }
        const attached = token.slice(j + 1);
        if (attached) {
          options.push({ flag, name, value: attached });
        } else {
          options.push({ flag, name, value: next(i, flag) });
          i++;
        }
        break;
      }
      continue;
    }
    urls.push(token);
  }
  return { options, urls };
}

/** curl_easy_escape: everything but RFC 3986 unreserved characters is %-encoded. */
function curlEscape(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Parse one POSIX-style cURL invocation. This is deliberately a lexer, not a
 * shell: expansions, command substitutions, globbing, config files, stdin,
 * and local-file reads are never evaluated.
 */
export function importCurlCommand(source: string): ImportResult {
  return parseCurlCommand(source).result;
}

/**
 * Parse a cURL command. Besides the import result, reports the settings the
 * command's flags set explicitly (-L, --max-redirs, --max-time, -k, --proxy,
 * --tlsv1.x) — the result's `settings` also carries defaults for the rest,
 * which a paste into an existing request must not apply over the user's own.
 */
export function parseCurlCommand(source: string): {
  result: ImportResult;
  explicitSettings: Partial<RequestSettings>;
} {
  const tokens = lexPosix(source);
  if (tokens.some((token) => SHELL_OPERATORS.has(token))) {
    throw new Error(
      'Only one cURL command may be imported; shell command chaining is not supported.'
    );
  }
  if (tokens[0]?.toLowerCase() !== 'curl') {
    throw new Error('Expected one POSIX cURL command beginning with "curl".');
  }

  const warnings: ImportWarning[] = [];
  const headers: KeyValue[] = [];
  const params: KeyValue[] = [];
  const formData: Array<{
    id: string;
    key: string;
    value: string;
    enabled: boolean;
    type: 'text' | 'file';
  }> = [];
  let method: string | undefined;
  let url: string | undefined;
  // Every -d family argument, in order. curl joins them with '&' (--json pieces
  // are concatenated as-is) and sends the result as one body.
  const dataParts: Array<{ text: string; json: boolean }> = [];
  let hasData = false;
  let hasJson = false;
  const queryParts: string[] = [];
  let useGet = false;
  let head = false;
  let upload = false;
  let userAgent: string | undefined;
  let referer: string | undefined;
  let credentials: { username: string; password: string } | undefined;
  let authScheme: 'basic' | 'digest' | 'ntlm' = 'basic';
  let bearer: string | undefined;
  let cookie: string | undefined;
  const settings: Partial<RequestSettings> = {};

  const addHeader = (value: string) => {
    const colon = value.indexOf(':');
    if (colon <= 0) {
      warnings.push({ kind: 'unsupported-option', option: '-H (malformed header)' });
      return;
    }
    headers.push({
      id: uuid(),
      key: value.slice(0, colon).trim(),
      value: value.slice(colon + 1).trim(),
      enabled: true,
    });
  };
  const fileReference = (flag: string, value: string): boolean => {
    if (!value.startsWith('@')) return false;
    warnings.push({ kind: 'unresolved-file', option: flag, path: value.slice(1) });
    return true;
  };
  /** `--data-urlencode` / `--url-query` content, encoded per curl's rules. */
  const urlencodeArg = (flag: string, value: string): string | undefined => {
    let separator = value.indexOf('=');
    if (separator === -1) separator = value.indexOf('@');
    if (separator !== -1 && value[separator] === '@') {
      warnings.push({ kind: 'unresolved-file', option: flag, path: value.slice(separator + 1) });
      return undefined;
    }
    const name = separator > 0 ? value.slice(0, separator) : '';
    const encoded = curlEscape(separator === -1 ? value : value.slice(separator + 1));
    return name ? `${name}=${encoded}` : encoded;
  };

  const { options, urls } = parseArgs(tokens);
  for (const { flag, name, value = '' } of options) {
    switch (name) {
      case 'request':
        method = value;
        break;
      case 'url':
        url ??= value;
        break;
      case 'header':
        addHeader(value);
        break;
      case 'user-agent':
        userAgent = value;
        break;
      case 'referer':
        // `;auto` only toggles curl's redirect bookkeeping.
        referer = value.replace(/;auto$/, '');
        break;
      case 'cookie':
        // An argument without '=' is a cookie *file* to read.
        if (!value.includes('=')) {
          warnings.push({ kind: 'unresolved-file', option: flag, path: value });
          break;
        }
        cookie = cookie ? `${cookie}; ${value}` : value;
        break;
      case 'user': {
        const separator = value.indexOf(':');
        credentials = {
          username: separator === -1 ? value : value.slice(0, separator),
          password: separator === -1 ? '' : value.slice(separator + 1),
        };
        break;
      }
      case 'basic':
      case 'digest':
      case 'ntlm':
        authScheme = name;
        break;
      case 'oauth2-bearer':
        bearer = value;
        break;
      case 'data':
      case 'data-ascii':
        hasData = true;
        // `@file` reads (and strips newlines from) a local file: never read.
        if (!fileReference(flag, value)) dataParts.push({ text: value, json: false });
        break;
      case 'data-binary':
        hasData = true;
        if (!fileReference(flag, value)) dataParts.push({ text: value, json: false });
        break;
      case 'data-raw':
        hasData = true;
        dataParts.push({ text: value, json: false });
        break;
      case 'data-urlencode': {
        hasData = true;
        const encoded = urlencodeArg(flag, value);
        if (encoded !== undefined) dataParts.push({ text: encoded, json: false });
        break;
      }
      case 'json':
        hasData = true;
        hasJson = true;
        if (!fileReference(flag, value)) dataParts.push({ text: value, json: true });
        break;
      case 'url-query': {
        const encoded = value.startsWith('+') ? value.slice(1) : urlencodeArg(flag, value);
        if (encoded !== undefined) queryParts.push(encoded);
        break;
      }
      case 'get':
        useGet = true;
        break;
      case 'head':
        head = true;
        break;
      case 'upload-file':
        upload = true;
        warnings.push({ kind: 'unresolved-file', option: flag, path: value });
        break;
      case 'form':
      case 'form-string': {
        const equal = value.indexOf('=');
        const key = equal === -1 ? value : value.slice(0, equal);
        const formValue = equal === -1 ? '' : value.slice(equal + 1);
        // --form-string is literal: a leading '@' or '<' is data, never a file.
        const literal = name === 'form-string';
        const filePath =
          !literal && formValue.startsWith('@')
            ? (formValue.slice(1).split(';', 1)[0] ?? '')
            : undefined;
        const contentPath =
          !literal && formValue.startsWith('<')
            ? (formValue.slice(1).split(';', 1)[0] ?? '')
            : undefined;
        if (filePath) warnings.push({ kind: 'unresolved-file', option: flag, path: filePath });
        if (contentPath)
          warnings.push({ kind: 'unresolved-file', option: flag, path: contentPath });
        formData.push({
          id: uuid(),
          key,
          value: filePath || contentPath ? '' : formValue,
          enabled: true,
          type: filePath ? 'file' : 'text',
        });
        break;
      }
      case 'location':
        settings.followRedirects = true;
        break;
      case 'max-redirs':
        settings.maxRedirects = positiveInt(value, flag);
        break;
      case 'max-time':
        settings.timeout = positiveSeconds(value, flag);
        break;
      case 'proxy':
        settings.proxy = parseProxy(value);
        break;
      case 'insecure':
        settings.verifySsl = false;
        break;
      case 'tlsv1.2':
        settings.minTlsVersion = 'TLSv1.2';
        break;
      case 'tlsv1.3':
        settings.minTlsVersion = 'TLSv1.3';
        break;
      default:
        if (FILE_OPTIONS.has(name))
          warnings.push({ kind: 'unresolved-file', option: flag, path: value });
        else if (!IGNORED_OPTIONS.has(name))
          warnings.push({ kind: 'unsupported-option', option: flag });
    }
  }

  url = url ?? urls[0];
  for (const extra of urls.slice(url === urls[0] ? 1 : 0)) {
    warnings.push({ kind: 'unsupported-option', option: extra });
  }
  if (!url) throw new Error('cURL command does not contain a URL.');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('cURL command contains an invalid URL.');
  }

  const findHeader = (key: string) =>
    headers.find((header) => header.key.toLowerCase() === key.toLowerCase());
  const joinData = () =>
    dataParts.reduce(
      (joined, part, index) =>
        index === 0
          ? part.text
          : `${joined}${part.json && dataParts[index - 1]?.json ? '' : '&'}${part.text}`,
      ''
    );

  // -G moves the data into the query string and keeps the request bodiless.
  if (useGet && hasData) {
    queryParts.push(...dataParts.filter((part) => part.text !== '').map((part) => part.text));
  }
  const sendsBody = hasData && !useGet;
  // Keep query values exactly as typed: the executor sends them byte-for-byte
  // (Postman behaviour), so decoding here would turn a pasted `%2B` into a `+`
  // the server reads as a space. Only `%26`/`%23` (and `%3D` in a key) are
  // undone — the URL bar writes them again, so the wire bytes are unchanged.
  for (const part of [parsedUrl.search.slice(1), ...queryParts]) {
    for (const { key, value } of parseRawQuery(part)) {
      params.push({ id: uuid(), key, value, enabled: true });
    }
  }
  parsedUrl.search = '';

  if (userAgent !== undefined && !findHeader('User-Agent'))
    headers.push({ id: uuid(), key: 'User-Agent', value: userAgent, enabled: true });
  if (referer !== undefined && !findHeader('Referer'))
    headers.push({ id: uuid(), key: 'Referer', value: referer, enabled: true });
  if (cookie) headers.push({ id: uuid(), key: 'Cookie', value: cookie, enabled: true });
  if (sendsBody && hasJson) {
    // --json sets both headers unless the command overrides them.
    if (!findHeader('Content-Type'))
      headers.push({ id: uuid(), key: 'Content-Type', value: 'application/json', enabled: true });
    if (!findHeader('Accept'))
      headers.push({ id: uuid(), key: 'Accept', value: 'application/json', enabled: true });
  }

  const defaultMethod = head
    ? 'HEAD'
    : useGet
      ? 'GET'
      : upload
        ? 'PUT'
        : sendsBody || formData.length > 0
          ? 'POST'
          : 'GET';
  const requestName = `${(method ?? defaultMethod).toUpperCase()} ${parsedUrl.hostname}`;
  const request: HttpRequest = {
    id: uuid(),
    name: requestName,
    type: 'http',
    method: coerceHttpMethod(method ?? defaultMethod, requestName, warnings),
    url: parsedUrl.toString(),
    headers,
    params,
    body:
      formData.length > 0
        ? { type: 'form-data', formData }
        : sendsBody
          ? { type: dataBodyType(findHeader('Content-Type')?.value, hasJson), raw: joinData() }
          : { type: 'none' },
    auth: buildAuth(bearer, credentials, authScheme),
    settings: { timeout: 0, followRedirects: false, maxRedirects: 5, verifySsl: true, ...settings },
  };
  return {
    result: {
      collection: {
        id: uuid(),
        name: `cURL: ${parsedUrl.hostname}`,
        items: [{ id: uuid(), name: requestName, type: 'request', request }],
      },
      warnings,
    },
    explicitSettings: settings,
  };
}

/**
 * The stored body type for -d family data. curl sends it as
 * application/x-www-form-urlencoded unless a header (or --json) says otherwise;
 * the body is always the bytes as written — never base64, never re-encoded.
 */
function dataBodyType(contentType: string | undefined, json: boolean): HttpRequest['body']['type'] {
  const type = contentType?.toLowerCase();
  if (type === undefined) return json ? 'json' : 'x-www-form-urlencoded';
  if (type.includes('x-www-form-urlencoded')) return 'x-www-form-urlencoded';
  if (type.includes('json')) return 'json';
  if (type.includes('xml')) return 'xml';
  // Any other explicit type: text travels with the request's own Content-Type
  // header, which always wins over a body type's default.
  return 'text';
}

function buildAuth(
  bearer: string | undefined,
  credentials: { username: string; password: string } | undefined,
  scheme: 'basic' | 'digest' | 'ntlm'
): AuthConfig {
  if (bearer !== undefined) return { type: 'bearer', bearer: { token: bearer } };
  if (!credentials) return { type: 'none' };
  if (scheme === 'digest') return { type: 'digest', digest: credentials };
  if (scheme === 'ntlm') return { type: 'ntlm', ntlm: credentials };
  return { type: 'basic', basic: credentials };
}

const ANSI_C_SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '\\': '\\',
  "'": "'",
  '"': '"',
};

/**
 * Decode one bash ANSI-C (`$'…'`) escape whose backslash sits at `start`.
 * Returns the decoded text and the index of the escape's last character.
 * Unknown escapes are kept verbatim (backslash included), as bash does.
 */
function decodeAnsiCEscape(source: string, start: number): { text: string; end: number } {
  const kind = source[start + 1] ?? '';
  const simple = ANSI_C_SIMPLE_ESCAPES[kind];
  if (simple !== undefined) return { text: simple, end: start + 1 };
  const width = kind === 'x' ? 2 : kind === 'u' ? 4 : 0;
  if (width > 0) {
    const digits = /^[0-9a-fA-F]+/.exec(source.slice(start + 2, start + 2 + width))?.[0];
    if (digits) {
      return {
        text: String.fromCodePoint(Number.parseInt(digits, 16)),
        end: start + 1 + digits.length,
      };
    }
  }
  return { text: `\\${kind}`, end: start + 1 };
}

function lexPosix(source: string): string[] {
  const tokens: string[] = [];
  let current = '';
  // `ansi` is bash's `$'…'` quoting (Chrome DevTools "Copy as cURL" emits it).
  let quote: "'" | '"' | 'ansi' | undefined;
  // A quoted-but-empty word (`-d ''`) is still an argument; without this flag
  // it would vanish and the next word (the URL) would become the option value.
  let quoted = false;
  const push = () => {
    if (current || quoted) tokens.push(current);
    current = '';
    quoted = false;
  };
  for (let i = 0; i < source.length; i++) {
    const char = source.charAt(i);
    if (quote === 'ansi') {
      if (char === "'") {
        quote = undefined;
      } else if (char === '\\' && i + 1 < source.length) {
        const decoded = decodeAnsiCEscape(source, i);
        current += decoded.text;
        i = decoded.end;
      } else {
        current += char;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      if (quote === '"' && char === '\\' && i + 1 < source.length) {
        // A backslash-newline inside double quotes is a line continuation.
        if (source[i + 1] === '\n') i++;
        else if (source[i + 1] === '\r' && source[i + 2] === '\n') i += 2;
        else current += source.charAt(++i);
      } else current += char;
      continue;
    }
    if (char === '$' && source[i + 1] === "'") {
      quote = 'ansi';
      quoted = true;
      i++;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
      continue;
    }
    if (char === '`')
      throw new Error('PowerShell/cmd syntax is not supported; paste POSIX shell cURL syntax.');
    if (char === '\\') {
      // Line continuation, LF or Windows CRLF.
      if (source[i + 1] === '\n') {
        i++;
        continue;
      }
      if (source[i + 1] === '\r' && source[i + 2] === '\n') {
        i += 2;
        continue;
      }
      if (i + 1 < source.length) current += source.charAt(++i);
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    if (char === ';' || char === '|' || char === '&') {
      push();
      const next = source[i + 1];
      tokens.push(
        next === char && (char === '|' || char === '&') ? `${char}${source.charAt(++i)}` : char
      );
      continue;
    }
    current += char;
  }
  if (quote) throw new Error('Unterminated POSIX shell quote in cURL command.');
  push();
  return tokens;
}

function positiveInt(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`cURL option ${option} must be a non-negative integer.`);
  return parsed;
}

function positiveSeconds(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`cURL option ${option} must be a non-negative number.`);
  return Math.round(parsed * 1000);
}

function parseProxy(value: string): ProxyConfig {
  const url = new URL(value.includes('://') ? value : `http://${value}`);
  const type = url.protocol.slice(0, -1);
  if (type !== 'http' && type !== 'https' && type !== 'socks4' && type !== 'socks5')
    throw new Error(`Unsupported cURL proxy protocol: ${url.protocol}`);
  return {
    enabled: true,
    type,
    host: url.hostname,
    port: Number(url.port || (type === 'https' ? 443 : 80)),
  };
}

/** Split a query string into rows without decoding values (see the caller). */
function parseRawQuery(query: string): Array<{ key: string; value: string }> {
  const unescapeQueryPart = (text: string, isKey: boolean) => {
    const out = text.replace(/%26/g, '&').replace(/%23/g, '#');
    return isKey ? out.replace(/%3D/gi, '=') : out;
  };
  return query
    .split('&')
    .filter((pair) => pair !== '')
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq === -1
        ? { key: unescapeQueryPart(pair, true), value: '' }
        : {
            key: unescapeQueryPart(pair.slice(0, eq), true),
            value: unescapeQueryPart(pair.slice(eq + 1), false),
          };
    });
}
