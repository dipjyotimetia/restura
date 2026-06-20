import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { bindLocalhost, closeServer } from '../utils/serverHelpers';

/**
 * Minimal SOCKS5 proxy (no-auth) for exercising the desktop SOCKS transport
 * (`openSocksSocket` in http-handler). Implements just enough of RFC 1928: the
 * method-negotiation greeting (replies NO-AUTH), a CONNECT with a DOMAIN or IPv4
 * address, then splices client↔upstream. Records each CONNECT so a test can prove
 * the request tunnelled through SOCKS rather than going direct.
 */
export interface MockSocksProxyHandle {
  port: number;
  /** Number of CONNECT requests tunnelled. */
  connectCount: () => number;
  /** `host:port` targets requested via CONNECT. */
  connectHosts: () => string[];
  reset: () => void;
  close: () => Promise<void>;
}

export async function startMockSocksProxyServer(
  opts: { port?: number } = {}
): Promise<MockSocksProxyHandle> {
  let connectCount = 0;
  const connectHosts: string[] = [];
  const live = new Set<Socket>();

  const server: Server = createServer((client) => {
    live.add(client);
    client.on('error', () => {});
    client.on('close', () => live.delete(client));

    // Phase 1: method-negotiation greeting → reply NO-AUTH (0x00).
    client.once('data', (greeting: Buffer) => {
      if (greeting[0] !== 0x05) {
        client.destroy();
        return;
      }
      client.write(Buffer.from([0x05, 0x00]));

      // Phase 2: CONNECT request.
      client.once('data', (req: Buffer) => {
        if (req[0] !== 0x05 || req[1] !== 0x01) {
          client.destroy();
          return;
        }
        const atyp = req[3];
        let host: string;
        let offset: number;
        if (atyp === 0x03) {
          const len = req[4]!;
          host = req.subarray(5, 5 + len).toString('ascii');
          offset = 5 + len;
        } else if (atyp === 0x01) {
          host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
          offset = 8;
        } else {
          // Address type not supported.
          client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const port = req.readUInt16BE(offset);
        connectCount += 1;
        connectHosts.push(`${host}:${port}`);

        const upstream = createConnection({ host, port });
        live.add(upstream);
        upstream.on('close', () => live.delete(upstream));
        upstream.on('error', () => {
          // General SOCKS failure (0x01).
          try {
            client.end(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          } catch {
            /* already gone */
          }
        });
        upstream.once('connect', () => {
          // Success reply (BND.ADDR/PORT are ignored by the client).
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          upstream.pipe(client);
          client.pipe(upstream);
        });
      });
    });
  });

  const port = await bindLocalhost(server, opts.port);
  return {
    port,
    connectCount: () => connectCount,
    connectHosts: () => connectHosts.slice(),
    reset: () => {
      connectCount = 0;
      connectHosts.splice(0, connectHosts.length);
    },
    close: async () => {
      for (const s of live) {
        try {
          s.destroy();
        } catch {
          /* already gone */
        }
      }
      live.clear();
      await closeServer(server);
    },
  };
}
