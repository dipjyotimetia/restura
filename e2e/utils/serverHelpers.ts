import type { IncomingMessage, ServerResponse } from 'node:http';

interface CloseableServer {
  listen: (port: number, host: string, cb: () => void) => unknown;
  address: () => { port: number } | string | null;
  close: (cb: (err?: Error) => void) => unknown;
  closeAllConnections?: () => void;
  once?: (event: 'error', cb: (err: NodeJS.ErrnoException) => void) => unknown;
  removeListener?: (event: 'error', cb: (err: NodeJS.ErrnoException) => void) => unknown;
}

export async function bindLocalhost(
  server: CloseableServer,
  port = 0,
  host = '127.0.0.1'
): Promise<number> {
  // listen() reports bind failures via the 'error' event, not the callback —
  // wire it up so a failed bind rejects instead of hanging or throwing unhandled.
  const attempt = (bindHost: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => reject(err);
      server.once?.('error', onError);
      server.listen(port, bindHost, () => {
        server.removeListener?.('error', onError);
        resolve();
      });
    });

  try {
    await attempt(host);
  } catch (err) {
    // Dual-stack intent ('::') degrades to the IPv4 wildcard on hosts without
    // IPv6 (containers/CI frequently lack it), where binding '::' fails with
    // EAFNOSUPPORT/EADDRNOTAVAIL. '0.0.0.0' stays reachable via 127.0.0.1 —
    // exactly what a '*.localhost' hostname resolves to with no IPv6 configured.
    const code = (err as NodeJS.ErrnoException).code;
    const ipv6Wildcard = host === '::' || host === '::0';
    if (ipv6Wildcard && (code === 'EAFNOSUPPORT' || code === 'EADDRNOTAVAIL')) {
      await attempt('0.0.0.0');
    } else {
      throw err;
    }
  }

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error(`Failed to bind on ${host}`);
  }
  return addr.port;
}

/**
 * Map a `*.localhost` / `localhost` hostname to the IPv4 loopback address.
 *
 * `*.localhost` is loopback by spec (RFC 6761), but resolving it relies on a
 * host NSS module (e.g. nss-myhostname) that minimal containers/CI images often
 * lack — there `getaddrinfo('upstream.localhost')` returns ENOTFOUND. The mock
 * proxies forward to such hostnames, so they resolve them here instead of
 * trusting the host resolver, keeping the e2e self-contained. A non-localhost
 * host is returned unchanged.
 */
export function loopbackHost(host: string): string {
  const h = host.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') ? '127.0.0.1' : host;
}

export function closeServer(server: CloseableServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson<T = unknown>(req: IncomingMessage): Promise<T | null> {
  const text = await readBody(req);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export interface CorsOptions {
  methods?: string;
  headers?: string;
  exposeHeaders?: string;
}

export function applyCors(res: ServerResponse, opts: CorsOptions = {}): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader(
    'access-control-allow-methods',
    opts.methods ?? 'GET,POST,PUT,DELETE,PATCH,OPTIONS,HEAD'
  );
  res.setHeader('access-control-allow-headers', opts.headers ?? '*');
  if (opts.exposeHeaders) {
    res.setHeader('access-control-expose-headers', opts.exposeHeaders);
  }
}

export function handlePreflight(req: IncomingMessage, res: ServerResponse): boolean {
  // An OPTIONS request is a valid API operation. It is a CORS preflight only
  // when the browser supplies the request-method negotiation header.
  if (req.method !== 'OPTIONS' || !req.headers['access-control-request-method']) return false;
  res.writeHead(204);
  res.end();
  return true;
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function basicAuthHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = String(req.headers.authorization ?? '');
  const m = /^Bearer\s+(.+)$/.exec(header);
  return m ? m[1]! : null;
}

export function isSecure(req: IncomingMessage): boolean {
  return (req.socket as { encrypted?: boolean }).encrypted === true;
}
