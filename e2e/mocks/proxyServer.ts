import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { URL } from 'node:url';
import { bindLocalhost, closeServer, loopbackHost } from '../utils/serverHelpers';

export interface MockProxyServerHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
  connectCount: () => number;
  forwardCount: () => number;
  connectHosts: () => string[];
  authChallengeCount: () => number;
  /** Require these Basic credentials on every forward and CONNECT. */
  setBasicAuth: (user: string, pass: string) => void;
  /** Disable auth (the default state). */
  clearBasicAuth: () => void;
  reset: () => void;
}

interface Closable {
  destroy(error?: Error): unknown;
  once(event: 'close', cb: () => void): unknown;
}

export async function startMockProxyServer(
  opts: { port?: number } = {}
): Promise<MockProxyServerHandle> {
  let connectCount = 0;
  let forwardCount = 0;
  let authChallengeCount = 0;
  const connectHosts: string[] = [];
  const liveSockets = new Set<Closable>();
  const trackSocket = (s: Closable): void => {
    liveSockets.add(s);
    s.once('close', () => liveSockets.delete(s));
  };

  let expectedAuth: string | null = null;
  function setBasicAuth(user: string, pass: string): void {
    expectedAuth = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
  function clearBasicAuth(): void {
    expectedAuth = null;
  }
  function authOk(headerValue: string | undefined): boolean {
    if (expectedAuth === null) return true;
    return headerValue === expectedAuth;
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!authOk(req.headers['proxy-authorization'])) {
      authChallengeCount += 1;
      res.writeHead(407, {
        'content-type': 'text/plain',
        'proxy-authenticate': 'Basic realm="restura-mock-proxy"',
      });
      res.end('Proxy: authentication required');
      return;
    }

    forwardCount += 1;

    const target = (() => {
      try {
        return new URL(req.url ?? '');
      } catch {
        return null;
      }
    })();

    if (!target || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Proxy: bad target URL');
      return;
    }
    if (target.protocol === 'https:') {
      res.writeHead(501, { 'content-type': 'text/plain' });
      res.end('Proxy: HTTPS forwarding requires CONNECT');
      return;
    }

    const upstream = createConnection({
      host: loopbackHost(target.hostname),
      port: target.port ? Number(target.port) : 80,
    });
    trackSocket(upstream);

    upstream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`Proxy upstream error: ${err.message}`);
      }
    });

    upstream.once('connect', () => {
      const path = target.pathname + target.search;
      const headers: Record<string, string | string[] | undefined> = {
        ...req.headers,
        host: target.host,
        'x-forwarded-by': 'mock-proxy',
      };
      delete headers['proxy-connection'];
      upstream.write(`${req.method ?? 'GET'} ${path} HTTP/1.1\r\n`);
      for (const [k, v] of Object.entries(headers)) {
        if (v == null) continue;
        upstream.write(`${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}\r\n`);
      }
      upstream.write('\r\n');
      req.pipe(upstream);
      upstream.pipe(res.socket!);
    });
  });

  server.on('connect', (req, clientSocket, head) => {
    if (!authOk(req.headers['proxy-authorization'])) {
      authChallengeCount += 1;
      clientSocket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\n' +
          'Proxy-Authenticate: Basic realm="restura-mock-proxy"\r\n\r\n'
      );
      return;
    }
    connectCount += 1;
    const hostHeader = req.url ?? '';
    connectHosts.push(hostHeader);
    const [host, portStr] = hostHeader.split(':');
    if (!host || !portStr) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const port = Number(portStr);

    const upstream = createConnection({ host: loopbackHost(host), port });
    trackSocket(upstream);
    trackSocket(clientSocket);
    upstream.on('error', (err) => {
      clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${err.message}`);
    });
    upstream.once('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    clientSocket.on('error', () => upstream.destroy());
  });

  const port = await bindLocalhost(server, opts.port);

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const s of liveSockets) {
        try {
          s.destroy();
        } catch {
          /* already gone */
        }
      }
      liveSockets.clear();
      await closeServer(server);
    },
    connectCount: () => connectCount,
    forwardCount: () => forwardCount,
    connectHosts: () => connectHosts.slice(),
    authChallengeCount: () => authChallengeCount,
    setBasicAuth,
    clearBasicAuth,
    reset: () => {
      connectCount = 0;
      forwardCount = 0;
      authChallengeCount = 0;
      connectHosts.splice(0, connectHosts.length);
      expectedAuth = null;
    },
  };
}
