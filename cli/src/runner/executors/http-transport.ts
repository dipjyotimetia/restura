/**
 * Per-request transport settings for the CLI HTTP executor — the CLI side of
 * the desktop app's `RequestSettings` TLS/proxy knobs (`verifySsl`, `caCert`,
 * `clientCert`, `minTlsVersion`, `cipherSuites`, `serverCipherOrder`, `proxy`).
 *
 * Each setting is either applied (a dedicated undici dispatcher for that
 * request, layered over the run's `--ca` / `--insecure` / mTLS / `--proxy`
 * flags) or the request is refused with a clear reason — never silently
 * ignored. Refused: SOCKS proxies (the CLI only speaks HTTP(S) proxies) and
 * secrets held in the desktop keychain (a client-cert passphrase or proxy
 * password the CLI cannot read).
 */

import { type SecretValue, unwrapSecret } from '@shared/secrets/secret-ref';
import type { RequestSettingsOverride } from '@shared/types';
import { Agent, type Dispatcher, ProxyAgent } from 'undici';
import { tlsConnectOptions } from '../undiciFetcher';
import type { ExecuteOptions } from './types';

type Refusal = { ok: false; error: string };

/**
 * The desktop app's proxy bypass syntax (`electron/main/security/proxy-bypass.ts`,
 * which the CLI cannot import): exact host, `*.suffix` / `*suffix`, or a `*`
 * glob — literals never act as a regex.
 */
export function isProxyBypassed(hostname: string, bypassList: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return bypassList.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) return false;
    if (pattern.startsWith('*')) {
      const suffix = pattern.slice(1);
      return host.endsWith(suffix) || host === suffix.slice(1);
    }
    if (pattern.includes('*')) {
      const escaped = pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      return new RegExp(`^${escaped.join('.*')}$`).test(host);
    }
    return host === pattern;
  });
}

/** A plain or inline secret's text; a keychain handle / external ref is refused. */
function readSecret(value: SecretValue | undefined, what: string): string | undefined | Refusal {
  if (value === undefined) return undefined;
  if (typeof value === 'string' || value.kind === 'inline') return unwrapSecret(value);
  return {
    ok: false,
    error: `The ${what} is stored in the desktop keychain or an external secret store, which the CLI cannot read; the request was not sent.`,
  };
}

function isRefusal(value: unknown): value is Refusal {
  return typeof value === 'object' && value !== null && (value as Refusal).ok === false;
}

/**
 * The `tls.connect` options a request's own settings ask for (empty when it
 * sets none). `verifySsl: true` adds nothing: it is the seeded default, so the
 * run's `--insecure` still applies — only an explicit `false` relaxes checks.
 */
export function requestConnectOptions(
  settings: RequestSettingsOverride | undefined
): { ok: true; connect: Record<string, unknown> } | Refusal {
  const connect: Record<string, unknown> = {};
  if (!settings) return { ok: true, connect };
  if (settings.verifySsl === false) connect.rejectUnauthorized = false;
  if (settings.caCert?.pem) connect.ca = settings.caCert.pem;
  const cc = settings.clientCert;
  if (cc && (cc.pfx || (cc.cert && cc.key))) {
    const passphrase = readSecret(cc.passphrase, 'client certificate passphrase');
    if (isRefusal(passphrase)) return passphrase;
    if (cc.pfx) {
      connect.pfx = Buffer.from(cc.pfx, 'base64');
    } else {
      connect.cert = cc.cert;
      connect.key = cc.key;
    }
    if (passphrase) connect.passphrase = passphrase;
  }
  if (settings.serverCipherOrder) connect.honorCipherOrder = true;
  if (settings.cipherSuites) connect.ciphers = settings.cipherSuites;
  if (settings.minTlsVersion) connect.minVersion = settings.minTlsVersion;
  return { ok: true, connect };
}

type ProxyChoice =
  | { ok: true; kind: 'none' }
  | { ok: true; kind: 'direct' }
  | { ok: true; kind: 'proxy'; uri: string; token?: string };

/** What the request's own proxy setting asks for at `url`. */
function requestProxy(
  settings: RequestSettingsOverride | undefined,
  url: string
): ProxyChoice | Refusal {
  const proxy = settings?.proxy;
  if (!proxy?.enabled || proxy.type === 'none' || !proxy.host) return { ok: true, kind: 'none' };
  let hostname: string;
  try {
    hostname = new URL(url).hostname.replace(/^\[(.*)\]$/, '$1');
  } catch {
    return { ok: true, kind: 'none' };
  }
  // Same bypass syntax as the desktop app: a bypassed host goes direct.
  if (isProxyBypassed(hostname, proxy.bypassList ?? [])) return { ok: true, kind: 'direct' };
  if (proxy.type === 'socks4' || proxy.type === 'socks5') {
    return {
      ok: false,
      error: `This request sets a ${proxy.type.toUpperCase()} proxy, which the CLI cannot apply (SOCKS proxies are desktop-only); the request was not sent. Use an HTTP(S) proxy or the desktop app.`,
    };
  }
  const host =
    proxy.host.includes(':') && !proxy.host.startsWith('[') ? `[${proxy.host}]` : proxy.host;
  const uri = `${proxy.type}://${host}:${proxy.port}`;
  if (!proxy.auth?.username) return { ok: true, kind: 'proxy', uri };
  const password = readSecret(proxy.auth.password, 'proxy password');
  if (isRefusal(password)) return password;
  const token = `Basic ${Buffer.from(`${proxy.auth.username}:${password ?? ''}`).toString('base64')}`;
  return { ok: true, kind: 'proxy', uri, token };
}

/**
 * A dispatcher for this request when its settings need one (the caller closes
 * it once the response is read), `undefined` to use the run's transport, or a
 * refusal. The request's TLS options layer over the run's TLS flags; its own
 * proxy replaces `--proxy` / the `HTTP(S)_PROXY` env vars (like `--ca` with no
 * `--proxy`, a request-level TLS setting without a proxy connects directly).
 */
export function requestDispatcher(
  settings: RequestSettingsOverride | undefined,
  url: string,
  opts: Pick<ExecuteOptions, 'tls' | 'proxy'>
): { ok: true; dispatcher?: Dispatcher } | Refusal {
  const tls = requestConnectOptions(settings);
  if (!tls.ok) return tls;
  const proxy = requestProxy(settings, url);
  if (!proxy.ok) return proxy;
  if (Object.keys(tls.connect).length === 0 && proxy.kind === 'none') return { ok: true };

  const connect = { ...tlsConnectOptions(opts.tls), ...tls.connect };
  const hasTls = Object.keys(connect).length > 0;
  const proxyUri =
    proxy.kind === 'proxy' ? proxy.uri : proxy.kind === 'none' ? opts.proxy : undefined;
  if (proxyUri) {
    return {
      ok: true,
      dispatcher: new ProxyAgent({
        uri: proxyUri,
        ...(proxy.kind === 'proxy' && proxy.token ? { token: proxy.token } : {}),
        ...(hasTls ? { requestTls: connect } : {}),
      }),
    };
  }
  return { ok: true, dispatcher: new Agent(hasTls ? { connect } : {}) };
}
