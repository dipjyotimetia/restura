import {
  createSecureServer,
  createServer,
  type Http2SecureServer,
  type Http2Server,
  type Http2ServerRequest,
  type Http2ServerResponse,
} from 'node:http2';
import type { TLSSocket } from 'node:tls';
import { bindLocalhost } from '../utils/serverHelpers';
import { getSelfSignedCert } from './cert';

/**
 * HTTP/2 echo upstream for the per-request HTTP version setting (#864).
 *
 *  - TLS mode (`tls` given or `secure: true`): ALPN offers `h2` AND `http/1.1`
 *    (`allowHTTP1`), so a client can be shown to negotiate either.
 *  - Cleartext mode: h2c PRIOR KNOWLEDGE only (RFC 9113 §3.3). An HTTP/1.1
 *    client gets no usable response — that's the point of the fixture.
 *
 * Every path echoes `{ httpVersion, alpnProtocol, method, path }` as JSON so a
 * test (or a human in echo-local) can see which protocol actually carried the
 * request.
 */
export interface MockHttp2ServerHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export interface StartHttp2Options {
  port?: number;
  host?: string;
  /** Serve h2 over TLS (with HTTP/1.1 fallback). Omit for cleartext h2c. */
  secure?: boolean;
  /** Override the default self-signed leaf (implies `secure`). */
  tls?: { key: string | Buffer; cert: string | Buffer };
}

function handle(req: Http2ServerRequest, res: Http2ServerResponse): void {
  const alpn = (req.socket as Partial<TLSSocket>).alpnProtocol;
  const body = JSON.stringify({
    httpVersion: req.httpVersion,
    alpnProtocol: typeof alpn === 'string' ? alpn : null,
    method: req.method,
    path: req.url,
  });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
}

export async function startMockHttp2Server(
  opts: StartHttp2Options = {}
): Promise<MockHttp2ServerHandle> {
  const secure = opts.secure === true || opts.tls !== undefined;
  let server: Http2Server | Http2SecureServer;
  if (secure) {
    const tls = opts.tls ?? getSelfSignedCert();
    server = createSecureServer({ key: tls.key, cert: tls.cert, allowHTTP1: true }, handle);
  } else {
    server = createServer(handle);
  }
  // Track sessions/sockets so close() never hangs on a keep-alive h2 session.
  const sockets = new Set<{ destroy: () => void }>();
  server.on(
    'connection',
    (socket: { destroy: () => void; once: (e: string, cb: () => void) => void }) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    }
  );
  const port = await bindLocalhost(server, opts.port, opts.host);
  return {
    port,
    url: `${secure ? 'https' : 'http'}://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const s of sockets) s.destroy();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
