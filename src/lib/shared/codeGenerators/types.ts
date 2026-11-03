import { isInlineSecretRef } from '@/lib/shared/secretRef';
import type { HttpRequest, ProxyConfig, RequestSettings } from '@/types';

export interface GenerateOptions {
  request: HttpRequest;
  resolvedUrl: string;
  resolvedHeaders: Record<string, string>;
  resolvedParams: Record<string, string>;
  settings?: RequestSettings;
  /** Multipart fields for a form-data body (files carry their file name). */
  formData?: Array<{ key: string; value: string; type: 'text' | 'file' }>;
}

/** Printed instead of a proxy password that is masked or held as a handle/external ref. */
export const PROXY_PASSWORD_PLACEHOLDER = '<proxy-password>';

/**
 * Proxy credentials a snippet may print: the username, and the password as
 * plaintext only when it is a plain/inline value — a desktop handle or an
 * external reference never resolves in the renderer, so it becomes the
 * placeholder. Null when the proxy carries no usable credentials.
 */
export function proxyCredentials(
  proxy: ProxyConfig
): { username: string; password: string } | null {
  const auth = proxy.auth;
  if (!auth?.username) return null;
  const password =
    typeof auth.password === 'string'
      ? auth.password
      : isInlineSecretRef(auth.password)
        ? auth.password.value
        : PROXY_PASSWORD_PLACEHOLDER;
  return password ? { username: auth.username, password } : null;
}

/**
 * `scheme://user:pass@host:port` with percent-encoded credentials so `@ : /`
 * in a password cannot break the URL. The masked placeholder stays readable.
 */
export function proxyUrlOf(proxy: ProxyConfig): string {
  const creds = proxyCredentials(proxy);
  const encodePassword = (p: string) =>
    p === PROXY_PASSWORD_PLACEHOLDER ? p : encodeURIComponent(p);
  const userInfo = creds
    ? `${encodeURIComponent(creds.username)}:${encodePassword(creds.password)}@`
    : '';
  return `${proxy.type}://${userInfo}${proxy.host}:${proxy.port}`;
}

export const escapeShell = (str: string): string => `'${str.replace(/'/g, "'\\''")}'`;

/**
 * Shell word for an HTTP method. RFC 9110 tchar includes `` ` | & $ ' # `` — a
 * stored extension method must never reach a pasted shell command unquoted
 * (#857). Plain alphanumeric tokens stay bare so `curl -X GET` reads naturally.
 */
export const shellMethodWord = (method: string): string =>
  /^[A-Za-z0-9_-]+$/.test(method) ? method : escapeShell(method);

/**
 * Single-quoted PHP / Ruby string literal. Those languages interpolate `$var`,
 * `{$x}`, `#{x}`, `#$x`, `#@x` inside double quotes, and tchar allows `$ # '`,
 * so a method token is only inert inside single quotes (which interpret just
 * `\\` and `\'`).
 */
export const singleQuotedLiteral = (str: string): string =>
  `'${str.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export const escapeJson = (str: string): string =>
  str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/**
 * URL string with `{{var}}` references left readable: masked secrets stay as
 * references, and URL serialization would otherwise percent-encode the braces.
 */
export const urlWithVariables = (url: URL): string =>
  url
    .toString()
    .replace(/%7B%7B(.*?)%7D%7D/gi, (_m, name: string) => `{{${decodeURIComponent(name)}}}`);
