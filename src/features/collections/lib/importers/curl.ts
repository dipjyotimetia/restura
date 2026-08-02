import { v4 as uuid } from 'uuid';
import type { HttpRequest, KeyValue, ProxyConfig, RequestSettings } from '@/types';
import { coerceHttpMethod, type ImportResult, type ImportWarning } from './types';

const SHELL_OPERATORS = new Set([';', '|', '||', '&&', '&']);

/**
 * Parse one POSIX-style cURL invocation. This is deliberately a lexer, not a
 * shell: expansions, command substitutions, globbing, config files, stdin,
 * and local-file reads are never evaluated.
 */
export function importCurlCommand(source: string): ImportResult {
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
  let rawBody: string | undefined;
  let bodyKind: HttpRequest['body']['type'] = 'none';
  let basic: { username: string; password: string } | undefined;
  let cookie: string | undefined;
  let settings: Partial<RequestSettings> = {};

  const take = (index: number, option: string): string => {
    const value = tokens[index + 1];
    if (!value || value.startsWith('-')) throw new Error(`cURL option ${option} requires a value.`);
    return value;
  };
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

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    switch (token) {
      case '-X':
      case '--request':
        method = take(i, token);
        i++;
        break;
      case '--url':
        url = take(i, token);
        i++;
        break;
      case '-H':
      case '--header':
        addHeader(take(i, token));
        i++;
        break;
      case '-b':
      case '--cookie': {
        const value = take(i, token);
        cookie = cookie ? `${cookie}; ${value}` : value;
        i++;
        break;
      }
      case '-u':
      case '--user': {
        const value = take(i, token);
        const separator = value.indexOf(':');
        basic = {
          username: separator === -1 ? value : value.slice(0, separator),
          password: separator === -1 ? '' : value.slice(separator + 1),
        };
        i++;
        break;
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-ascii':
      case '--data-urlencode': {
        const value = take(i, token);
        if (value.startsWith('@'))
          warnings.push({ kind: 'unresolved-file', option: token, path: value.slice(1) });
        rawBody = rawBody === undefined ? value : `${rawBody}&${value}`;
        bodyKind = token === '--data-urlencode' ? 'x-www-form-urlencoded' : 'text';
        i++;
        break;
      }
      case '--data-binary': {
        const value = take(i, token);
        if (value.startsWith('@'))
          warnings.push({ kind: 'unresolved-file', option: token, path: value.slice(1) });
        else rawBody = value;
        bodyKind = 'binary';
        i++;
        break;
      }
      case '-F':
      case '--form': {
        const value = take(i, token);
        const equal = value.indexOf('=');
        const key = equal === -1 ? value : value.slice(0, equal);
        const formValue = equal === -1 ? '' : value.slice(equal + 1);
        const filePath = formValue.startsWith('@')
          ? formValue.slice(1).split(';', 1)[0]!
          : undefined;
        if (filePath) warnings.push({ kind: 'unresolved-file', option: token, path: filePath });
        formData.push({
          id: uuid(),
          key,
          value: filePath ? '' : formValue,
          enabled: true,
          type: filePath ? 'file' : 'text',
        });
        bodyKind = 'form-data';
        i++;
        break;
      }
      case '-L':
      case '--location':
        settings.followRedirects = true;
        break;
      case '--max-redirs':
        settings.maxRedirects = positiveInt(take(i, token), token);
        i++;
        break;
      case '--max-time':
        settings.timeout = positiveSeconds(take(i, token), token);
        i++;
        break;
      case '-x':
      case '--proxy':
        settings.proxy = parseProxy(take(i, token));
        i++;
        break;
      case '-k':
      case '--insecure':
        settings.verifySsl = false;
        break;
      case '--tlsv1.2':
        settings.minTlsVersion = 'TLSv1.2';
        break;
      case '--tlsv1.3':
        settings.minTlsVersion = 'TLSv1.3';
        break;
      case '--cacert':
      case '--cert':
      case '--key':
        warnings.push({ kind: 'unresolved-file', option: token, path: take(i, token) });
        i++;
        break;
      case '--':
        if (tokens[i + 1]) url = tokens[i + 1];
        i = tokens.length;
        break;
      default:
        if (token.startsWith('-')) warnings.push({ kind: 'unsupported-option', option: token });
        else if (!url) url = token;
        else warnings.push({ kind: 'unsupported-option', option: token });
    }
  }

  if (!url) throw new Error('cURL command does not contain a URL.');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('cURL command contains an invalid URL.');
  }
  for (const [key, value] of parsedUrl.searchParams) {
    params.push({ id: uuid(), key, value, enabled: true });
  }
  parsedUrl.search = '';
  if (cookie) headers.push({ id: uuid(), key: 'Cookie', value: cookie, enabled: true });

  const contentType = headers
    .find((header) => header.key.toLowerCase() === 'content-type')
    ?.value.toLowerCase();
  if (rawBody && contentType?.includes('json')) bodyKind = 'json';
  const requestName = `${(method ?? (rawBody !== undefined || formData.length > 0 ? 'POST' : 'GET')).toUpperCase()} ${parsedUrl.hostname}`;
  const request: HttpRequest = {
    id: uuid(),
    name: requestName,
    type: 'http',
    method: coerceHttpMethod(
      method ?? (rawBody !== undefined || formData.length > 0 ? 'POST' : 'GET'),
      requestName,
      warnings
    ),
    url: parsedUrl.toString(),
    headers,
    params,
    body:
      bodyKind === 'form-data'
        ? { type: 'form-data', formData }
        : bodyKind === 'none'
          ? { type: 'none' }
          : { type: bodyKind, raw: rawBody },
    auth: basic ? { type: 'basic', basic } : { type: 'none' },
    settings: { timeout: 0, followRedirects: false, maxRedirects: 5, verifySsl: true, ...settings },
  };
  return {
    collection: {
      id: uuid(),
      name: `cURL: ${parsedUrl.hostname}`,
      items: [{ id: uuid(), name: requestName, type: 'request', request }],
    },
    warnings,
  };
}

function lexPosix(source: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  const push = () => {
    if (current) tokens.push(current);
    current = '';
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      if (quote === '"' && char === '\\' && i + 1 < source.length) current += source[++i]!;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '`')
      throw new Error('PowerShell/cmd syntax is not supported; paste POSIX shell cURL syntax.');
    if (char === '\\') {
      if (source[i + 1] === '\n') {
        i++;
        continue;
      }
      if (i + 1 < source.length) current += source[++i]!;
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
        next === char && (char === '|' || char === '&') ? `${char}${source[++i]!}` : char
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
