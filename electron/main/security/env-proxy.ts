/**
 * Resolves the standard `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` environment
 * variables into an upstream proxy for a given target URL. Used as a fallback
 * in the Electron HTTP fetcher when the user has not configured an explicit
 * proxy. Mirrors curl / undici `EnvHttpProxyAgent` semantics so the desktop
 * app behaves like every other CLI behind a corporate proxy:
 *   - `https:` targets use `HTTPS_PROXY` (then `https_proxy`); `http:` targets
 *     use `HTTP_PROXY` (then `http_proxy`). Lowercase wins only if the
 *     uppercase form is unset.
 *   - `NO_PROXY` (then `no_proxy`) is a comma/space-separated suffix list. A
 *     bare `*` disables proxying entirely; an entry may carry an optional
 *     `:port` that must match; a leading dot is optional — `example.com`
 *     matches `example.com` and any subdomain.
 *
 * Caveat: GUI-launched desktop apps on macOS/Windows do NOT inherit shell env
 * vars, so this mainly helps terminal- or MDM-launched instances. The explicit
 * in-app proxy config always takes precedence over these vars.
 */

export interface EnvProxy {
  type: 'http' | 'https';
  host: string;
  port: number;
  auth?: { username: string; password: string };
}

/**
 * Returns true when `hostname[:port]` matches a `NO_PROXY` entry and should
 * therefore bypass the proxy. A bare `*` matches everything.
 */
export function matchesNoProxy(
  hostname: string,
  port: number,
  noProxy: string | undefined
): boolean {
  if (!noProxy) return false;
  const entries = noProxy
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (entries.includes('*')) return true;

  const host = hostname.toLowerCase();
  for (const entry of entries) {
    let pattern = entry;
    const colon = pattern.lastIndexOf(':');
    if (colon !== -1 && /^\d+$/.test(pattern.slice(colon + 1))) {
      if (pattern.slice(colon + 1) !== String(port)) continue;
      pattern = pattern.slice(0, colon);
    }
    if (pattern.startsWith('.')) pattern = pattern.slice(1);
    if (host === pattern || host.endsWith('.' + pattern)) return true;
  }
  return false;
}

/**
 * Resolve the env-var proxy for `target`, or `undefined` when no proxy applies
 * (var unset, target bypassed by `NO_PROXY`, or the proxy URL is malformed).
 */
export function resolveEnvProxy(
  target: URL,
  env: NodeJS.ProcessEnv = process.env
): EnvProxy | undefined {
  const isHttps = target.protocol === 'https:';
  const raw = isHttps ? (env.HTTPS_PROXY ?? env.https_proxy) : (env.HTTP_PROXY ?? env.http_proxy);
  if (!raw) return undefined;

  const targetPort = target.port ? Number(target.port) : isHttps ? 443 : 80;
  if (matchesNoProxy(target.hostname, targetPort, env.NO_PROXY ?? env.no_proxy)) {
    return undefined;
  }

  let proxyUrl: URL;
  try {
    proxyUrl = new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch {
    return undefined;
  }

  const type = proxyUrl.protocol === 'https:' ? 'https' : 'http';
  const result: EnvProxy = {
    type,
    host: proxyUrl.hostname,
    port: proxyUrl.port ? Number(proxyUrl.port) : type === 'https' ? 443 : 80,
  };
  if (proxyUrl.username) {
    result.auth = {
      username: decodeURIComponent(proxyUrl.username),
      password: decodeURIComponent(proxyUrl.password),
    };
  }
  return result;
}
