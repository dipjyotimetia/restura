import * as dns from 'node:dns';
import type * as http from 'node:http';
import * as net from 'node:net';
import { assertResolvedAddressAllowed, isPrivateAddress } from '@shared/protocol/url-validation';
import { unwrapSecretValueMain } from '../security/secret-handle-store';
import type { ElectronProxyConfig } from './http-handler';

/**
 * Resolve a target once and reject DNS rebinding to prohibited addresses before
 * Undici connects. Cloud metadata remains blocked by the shared URL guard.
 */
export function createSecureLookup(
  hostname: string,
  allowLocalhost: boolean,
  allowPrivateIPs: boolean
): NonNullable<http.RequestOptions['lookup']> {
  const allowPrivate = allowPrivateIPs || (net.isIP(hostname) !== 0 && isPrivateAddress(hostname));
  return (lookupHostname, options, callback) => {
    dns.lookup(lookupHostname, options, (error, address, family) => {
      if (error) {
        callback(error, address as never, family as never);
        return;
      }
      const addresses = Array.isArray(address) ? address : [{ address, family }];
      try {
        for (const entry of addresses) {
          assertResolvedAddressAllowed(hostname, entry.address, {
            allowLocalhost,
            allowPrivateLiteralHost: allowPrivate,
            loopbackNeedsLocalhost: true,
          });
        }
        callback(null, address as never, family as never);
      } catch (error) {
        callback(error as Error, address as never, family as never);
      }
    });
  };
}

/** Open a raw TCP tunnel through a SOCKS4 or SOCKS5 proxy. */
export function openSocksSocket(
  proxy: ElectronProxyConfig,
  targetHost: string,
  targetPort: number,
  signal?: AbortSignal
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const socket = net.createConnection({
      host: proxy.host,
      port: proxy.port,
      lookup: createSecureLookup(proxy.host, true, false),
    });
    let settled = false;
    let dataListener: ((data: Buffer) => void) | undefined;
    const cleanup = () => {
      socket.removeListener('error', onError);
      socket.removeListener('connect', onConnect);
      if (dataListener) socket.removeListener('data', dataListener);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (cause: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(cause);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError = (cause: Error) => fail(cause);
    const onAbort = () => {
      const error = new Error('Operation cancelled.');
      error.name = 'AbortError';
      fail(error);
    };
    const onConnect = () => {
      if (proxy.type === 'socks4') {
        const port = Buffer.alloc(2);
        port.writeUInt16BE(targetPort, 0);
        const request = Buffer.concat([
          Buffer.from([0x04, 0x01]),
          port,
          Buffer.from([0x00, 0x00, 0x00, 0x01]),
          Buffer.from((proxy.auth?.username ?? '') + '\0', 'ascii'),
          Buffer.from(targetHost + '\0', 'ascii'),
        ]);
        socket.write(request);
        dataListener = (reply: Buffer) => {
          if (reply[1] === 0x5a) succeed();
          else fail(new Error(`SOCKS4 proxy rejected connection (code ${reply[1]})`));
        };
        socket.once('data', dataListener);
        return;
      }

      const hasAuth = !!proxy.auth?.username;
      socket.write(
        hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00])
      );
      dataListener = (greeting: Buffer) => {
        if (greeting[0] !== 0x05) {
          fail(new Error('SOCKS5 invalid server greeting'));
          return;
        }
        const sendConnect = () => {
          const host = Buffer.from(targetHost, 'ascii');
          const port = Buffer.alloc(2);
          port.writeUInt16BE(targetPort, 0);
          socket.write(
            Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port])
          );
          dataListener = (reply: Buffer) => {
            if (reply[1] !== 0x00) fail(new Error(`SOCKS5 connection failed (code ${reply[1]})`));
            else succeed();
          };
          socket.once('data', dataListener);
        };
        const password = unwrapSecretValueMain(proxy.auth?.password);
        if (greeting[1] === 0x00) {
          sendConnect();
        } else if (greeting[1] === 0x02 && proxy.auth?.username && password) {
          const user = Buffer.from(proxy.auth.username, 'utf8');
          const pass = Buffer.from(password, 'utf8');
          socket.write(
            Buffer.concat([
              Buffer.from([0x01, user.length]),
              user,
              Buffer.from([pass.length]),
              pass,
            ])
          );
          dataListener = (reply: Buffer) => {
            if (reply[1] !== 0x00) {
              fail(new Error('SOCKS5 authentication failed'));
              return;
            }
            sendConnect();
          };
          socket.once('data', dataListener);
        } else {
          fail(new Error('SOCKS5 no acceptable auth method'));
        }
      };
      socket.once('data', dataListener);
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
