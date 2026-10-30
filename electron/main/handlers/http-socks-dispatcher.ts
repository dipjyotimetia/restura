import type * as net from 'node:net';
import * as tls from 'node:tls';
import { Agent, type buildConnector } from 'undici';
import { type HttpVersionPlan, h2NotNegotiatedError } from './http-version';

/**
 * Creates an Agent that routes connections through a pre-established SOCKS socket.
 * Replaces the Node http.Agent / https.Agent subclass that overrode createConnection
 * in the previous implementation — same idea, expressed via undici's connect factory.
 */
export interface SocksTlsKnobs {
  serverCipherOrder?: boolean;
  cipherSuites?: string;
  minTlsVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
}

export function createSocksDispatcher(
  socksSocket: net.Socket,
  targetUrl: URL,
  isHttps: boolean,
  verifySsl: boolean,
  versionPlan: HttpVersionPlan,
  tlsKnobs?: SocksTlsKnobs,
  /**
   * mTLS client cert + custom CA material from `buildTlsClientMaterial`. Spread
   * into the SOCKS TLS handshake so certificates work through a SOCKS proxy
   * exactly as they do on the direct/HTTP-proxy paths. Omitting this silently
   * dropped mTLS and custom-CA settings whenever a SOCKS proxy was configured.
   */
  certMaterial?: Record<string, unknown>,
  /** Extra Agent options — the NTLM single-connection pin (`factory`). */
  agentOptions?: Pick<Agent.Options, 'factory'> & { proxyTunnel?: boolean }
): Agent {
  // undici's connector callback type is strictly [Error, null] | [null, Socket]; assert
  // through unknown so the TLSSocket / Socket variants are accepted.
  type SocksCallback = (err: Error | null, socket: net.Socket | null) => void;
  const { allowH2 } = versionPlan;
  return new Agent({
    ...(agentOptions?.factory ? { factory: agentOptions.factory } : {}),
    allowH2,
    connect: ((_opts: unknown, cb: SocksCallback) => {
      try {
        if (isHttps) {
          // Match the per-request TLS knobs honoured by buildConnectOptions so
          // SOCKS-tunneled requests get the same hardening (cipher list, min
          // protocol, server cipher order) plus mTLS client cert + custom CA.
          const tlsSocket = tls.connect({
            socket: socksSocket,
            servername: targetUrl.hostname,
            rejectUnauthorized: verifySsl,
            ALPNProtocols: allowH2 ? ['h2', 'http/1.1'] : ['http/1.1'],
            ...(tlsKnobs?.serverCipherOrder && { honorCipherOrder: true }),
            ...(tlsKnobs?.cipherSuites && { ciphers: tlsKnobs.cipherSuites }),
            ...(tlsKnobs?.minTlsVersion && { minVersion: tlsKnobs.minTlsVersion }),
            ...(certMaterial ?? {}),
          });
          tlsSocket.once('secureConnect', () => {
            // Snapshot the negotiated ALPN into the holder attached to the SOCKS socket
            // so the response builder can surface it in the response viewer.
            const holder = (socksSocket as unknown as { __alpnHolder?: { alpn?: string } })
              .__alpnHolder;
            if (holder && tlsSocket.alpnProtocol) {
              holder.alpn = tlsSocket.alpnProtocol;
            }
            if (versionPlan.requireH2 && tlsSocket.alpnProtocol !== 'h2') {
              tlsSocket.destroy();
              cb(h2NotNegotiatedError(tlsSocket.alpnProtocol || undefined), null);
              return;
            }
            cb(null, tlsSocket);
          });
          tlsSocket.once('error', (err) => cb(err, null));
        } else {
          // Match undici's socket contract: the dispatcher picks H1 vs H2 from
          // alpnProtocol on the raw socket. Plaintext is HTTP/1.1 unless the
          // request asked for h2c prior knowledge (no Upgrade path exists).
          const alpn = versionPlan.h2cPriorKnowledge ? 'h2' : 'http/1.1';
          (socksSocket as unknown as { alpnProtocol?: string }).alpnProtocol = alpn;
          const holder = (socksSocket as unknown as { __alpnHolder?: { alpn?: string } })
            .__alpnHolder;
          if (holder && versionPlan.h2cPriorKnowledge) holder.alpn = alpn;
          // Hand the socket over asynchronously: undici's dispatch loop is not
          // re-entrant, so a synchronous callback (the tunnel is already open)
          // drops the resume and the HTTP/1.1 request is never written.
          process.nextTick(() => cb(null, socksSocket));
        }
      } catch (err) {
        cb(err as Error, null);
      }
    }) as unknown as ReturnType<typeof buildConnector>,
  });
}
