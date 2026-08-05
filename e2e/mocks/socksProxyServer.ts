import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { bindLocalhost, closeServer, loopbackHost } from '../utils/serverHelpers';

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

    let buffered = Buffer.alloc(0);
    let authenticated = false;
    let connecting = false;

    // TCP framing is arbitrary: MQTT.js may send the SOCKS greeting and CONNECT
    // request in one chunk, or split either across several. Parse incrementally
    // so this mock validates the real client rather than a packet-boundary
    // accident of the test runner.
    client.on('data', (chunk: Buffer) => {
      if (connecting) return;
      buffered = Buffer.concat([buffered, chunk]);

      if (!authenticated) {
        if (buffered.length < 2) return;
        const methodCount = buffered[1]!;
        const greetingLength = 2 + methodCount;
        if (buffered.length < greetingLength || buffered[0] !== 0x05) {
          if (buffered.length >= greetingLength) client.destroy();
          return;
        }
        buffered = buffered.subarray(greetingLength);
        authenticated = true;
        client.write(Buffer.from([0x05, 0x00]));
      }

      if (buffered.length < 4) return;
      if (buffered[0] !== 0x05 || buffered[1] !== 0x01) {
        client.destroy();
        return;
      }

      const atyp = buffered[3];
      let host: string;
      let portOffset: number;
      if (atyp === 0x03) {
        if (buffered.length < 5) return;
        const length = buffered[4]!;
        portOffset = 5 + length;
        if (buffered.length < portOffset + 2) return;
        host = buffered.subarray(5, portOffset).toString('ascii');
      } else if (atyp === 0x01) {
        portOffset = 8;
        if (buffered.length < portOffset + 2) return;
        host = `${buffered[4]}.${buffered[5]}.${buffered[6]}.${buffered[7]}`;
      } else {
        // Address type not supported.
        client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        return;
      }

      const port = buffered.readUInt16BE(portOffset);
      buffered = buffered.subarray(portOffset + 2);
      connecting = true;
      connectCount += 1;
      connectHosts.push(`${host}:${port}`);

      const upstream = createConnection({ host: loopbackHost(host), port });
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
        if (buffered.length > 0) upstream.write(buffered);
        upstream.pipe(client);
        client.pipe(upstream);
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
