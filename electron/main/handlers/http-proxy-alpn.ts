import * as diagnosticsChannel from 'node:diagnostics_channel';
import type * as net from 'node:net';
import type * as tls from 'node:tls';

/**
 * Subscribes to undici's `undici:client:connected` diagnostics channel for
 * the lifetime of a single request through an HTTP/HTTPS proxy. The TLS
 * handshake to the upstream happens inside ProxyAgent (after the CONNECT
 * tunnel) and we have no public hook to wrap that connector — so we listen
 * on the global channel and correlate by host/port from `connectParams`.
 *
 * Returns an unsubscribe function the caller MUST invoke once the request
 * finishes or errors, otherwise the listener leaks.
 */
export function subscribeProxyAlpnCapture(
  hostname: string,
  port: number,
  holder: { alpn?: string }
): () => void {
  type ConnectedEvent = {
    connectParams?: { host?: string; hostname?: string; port?: string | number; protocol?: string };
    socket?: net.Socket | tls.TLSSocket;
  };
  const handler = (raw: unknown): void => {
    const evt = raw as ConnectedEvent;
    const cp = evt.connectParams;
    if (!cp) return;
    // undici copies these from a WHATWG URL: `port` is a string ('' for the
    // scheme default) and IPv6 hostnames arrive without brackets.
    const cpHost = (cp.hostname ?? cp.host ?? '').toLowerCase();
    const cpPort = Number(cp.port) || (cp.protocol === 'https:' ? 443 : 80);
    if (cpHost !== hostname.replace(/^\[|\]$/g, '').toLowerCase() || cpPort !== port) return;
    const sock = evt.socket as tls.TLSSocket | undefined;
    const alpn = sock && 'alpnProtocol' in sock ? sock.alpnProtocol : undefined;
    if (typeof alpn === 'string' && alpn.length > 0) {
      holder.alpn = alpn;
    }
  };
  diagnosticsChannel.subscribe('undici:client:connected', handler);
  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    try {
      diagnosticsChannel.unsubscribe('undici:client:connected', handler);
    } catch {
      // ignore — best-effort cleanup
    }
  };
}
