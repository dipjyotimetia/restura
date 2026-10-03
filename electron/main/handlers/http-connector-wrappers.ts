import type * as net from 'node:net';
import type * as tls from 'node:tls';
import type { ConnectionTimings } from '@shared/protocol/types';
import type { buildConnector } from 'undici';

// Wrappers around undici's connector for the direct (non-proxied) desktop
// HTTP path: ALPN capture and connection-phase timing. The Agent is created
// per request, so each request opens — and times — its own connection.

/**
 * Copy of the connect options whose DNS lookup records its duration in
 * `holder.dns`. IP-literal hosts skip the lookup, leaving `dns` unset.
 */
export function withTimedLookup(
  connectOpts: Record<string, unknown>,
  holder: ConnectionTimings
): Record<string, unknown> {
  const lookup = connectOpts.lookup as
    | ((host: string, options: unknown, callback: (...args: unknown[]) => void) => void)
    | undefined;
  if (!lookup) return connectOpts;
  return {
    ...connectOpts,
    lookup: (host: string, options: unknown, callback: (...args: unknown[]) => void) => {
      const started = performance.now();
      lookup(host, options, (...args: unknown[]) => {
        holder.dns = performance.now() - started;
        callback(...args);
      });
    },
  };
}

/**
 * Time the connector: on success `holder.connect` is the TCP (+ TLS) time,
 * i.e. the connector's duration minus the DNS lookup inside it.
 */
export function wrapConnectorForTiming(
  innerConnect: ReturnType<typeof buildConnector>,
  holder: ConnectionTimings
): ReturnType<typeof buildConnector> {
  type Cb = (err: Error | null, socket: net.Socket | null) => void;
  return ((opts: Parameters<ReturnType<typeof buildConnector>>[0], callback: Cb) => {
    const started = performance.now();
    innerConnect(opts, ((err: Error | null, socket: net.Socket | null) => {
      if (!err && socket) {
        holder.connect = Math.max(0, performance.now() - started - (holder.dns ?? 0));
      }
      callback(err, socket);
    }) as Parameters<ReturnType<typeof buildConnector>>[1]);
  }) as ReturnType<typeof buildConnector>;
}

/**
 * Wraps undici's default connector to capture the negotiated ALPN protocol
 * from the underlying TLS socket. The protocol is recorded on the supplied
 * holder so the fetcher can surface it on the FetcherResponse.
 */
export function wrapConnectorForAlpn(
  innerConnect: ReturnType<typeof buildConnector>,
  holder: { alpn?: string }
): ReturnType<typeof buildConnector> {
  type Cb = (err: Error | null, socket: net.Socket | null) => void;
  return ((opts: Parameters<ReturnType<typeof buildConnector>>[0], callback: Cb) => {
    innerConnect(opts, ((err: Error | null, socket: net.Socket | null) => {
      if (!err && socket) {
        // tls.TLSSocket exposes alpnProtocol; net.Socket leaves it undefined.
        const alpn = (socket as tls.TLSSocket).alpnProtocol;
        if (typeof alpn === 'string' && alpn.length > 0) {
          holder.alpn = alpn;
        }
      }
      callback(err, socket);
    }) as Parameters<ReturnType<typeof buildConnector>>[1]);
  }) as ReturnType<typeof buildConnector>;
}
