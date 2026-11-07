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

import { isProxyBypassed } from '@shared/protocol/proxy-bypass';
import { validateURL } from '@shared/protocol/url-validation';
import { type SecretValue, unwrapSecret } from '@shared/secrets/secret-ref';
import type { RequestSettingsOverride } from '@shared/types';
import { Agent, type Dispatcher, ProxyAgent } from 'undici';
import { guardedLookup, tlsConnectOptions } from '../undiciFetcher';
import type { ExecuteOptions } from './types';

type Refusal = { ok: false; error: string };

/**
 * The `lookup` the per-request proxy connection dials through: the same
 * SSRF-guarded resolution as every direct CLI connection (`guardedLookup`), so
 * a DNS name cannot re-point the proxy at an internal address after a preflight.
 */
export const guardedProxyLookup = guardedLookup;

/**
 * A collection's own proxy host is untrusted input: an absolute-form request
 * through a "proxy" at 169.254.169.254 or an RFC1918 / loopback address would
 * reach an internal service. Literal and well-known hosts are checked here;
 * DNS names are checked again on every resolution by `guardedProxyLookup`.
 * An operator's `--proxy` flag is trusted and not checked.
 */
function proxyHostRefusal(
  host: string,
  port: number,
  allowLocalhost: boolean
): Refusal | undefined {
  const checked = validateURL(`http://${host}:${port}/`, { allowLocalhost });
  if (checked.valid) return undefined;
  return {
    ok: false,
    error: `The request's proxy host ${host} is not allowed (${checked.error}); the request was not sent. Use --proxy for an internal proxy.`,
  };
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
  url: string,
  allowLocalhost: boolean
): ProxyChoice | Refusal {
  const proxy = settings?.proxy;
  if (!proxy?.enabled || proxy.type === 'none' || !proxy.host) return { ok: true, kind: 'none' };
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
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
  const refusal = proxyHostRefusal(host, proxy.port, allowLocalhost);
  if (refusal) return refusal;
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
  opts: Pick<ExecuteOptions, 'tls' | 'proxy' | 'allowLocalhost'>
): { ok: true; dispatcher?: Dispatcher } | Refusal {
  const tls = requestConnectOptions(settings);
  if (!tls.ok) return tls;
  const proxy = requestProxy(settings, url, opts.allowLocalhost);
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
        // The collection's proxy host dials through the SSRF-guarded lookup.
        ...(proxy.kind === 'proxy'
          ? { proxyTls: { lookup: guardedProxyLookup(opts.allowLocalhost) } }
          : {}),
        ...(hasTls ? { requestTls: connect } : {}),
      }),
    };
  }
  // Direct: the target dials through the SSRF-guarded lookup.
  return {
    ok: true,
    dispatcher: new Agent({ connect: { ...connect, lookup: guardedLookup(opts.allowLocalhost) } }),
  };
}
