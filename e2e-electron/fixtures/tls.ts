import path from 'node:path';
import { test as electronTest } from './electronApp';
import { startMockHttpsServer, type MockHttpServerHandle } from '../../e2e/mocks/httpServer';
import { ensureCerts, type EchoCerts } from '../../echo-local/certs';

/**
 * Boots TLS upstreams for the desktop-only customCa / mTLS specs, reusing the
 * echo-local CA material (`ensureCerts` — idempotent, openssl-backed). Both
 * listeners present a leaf signed by a PRIVATE CA the OS doesn't trust, so with
 * `verifySsl` on (the default) a successful response proves the custom CA / mTLS
 * material was actually applied to the handshake.
 *
 * Kept as its own fixture (not folded into `servers`) so a missing `openssl`
 * only fails the TLS specs rather than the whole desktop suite. Ports are
 * ephemeral — no collision with the fixed-port `echoLocal` stack.
 */
const ROOT = path.resolve(__dirname, '../..');

export interface TlsStack {
  /** HTTPS with a CA-signed leaf (no client cert required). */
  https: MockHttpServerHandle;
  /** HTTPS that demands a client cert (requestCert + rejectUnauthorized). */
  mtls: MockHttpServerHandle;
  /** HTTPS capped at TLSv1.2 — a client min-version floor of TLSv1.3 must fail. */
  tls12: MockHttpServerHandle;
  /** HTTPS at TLSv1.2 offering only ECDHE-RSA-AES128-GCM-SHA256 — a client that
   *  requests an incompatible cipher suite must fail the handshake. */
  cipherPinned: MockHttpServerHandle;
  /** The single cipher the `cipherPinned` server accepts. */
  pinnedCipher: string;
  certs: EchoCerts;
}

const PINNED_CIPHER = 'ECDHE-RSA-AES128-GCM-SHA256';

export const test = electronTest.extend<{ tls: TlsStack }, { _tls: TlsStack }>({
  _tls: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const certs = ensureCerts({ dir: path.join(ROOT, 'echo-local/certs') });
      const [https, mtls, tls12, cipherPinned] = await Promise.all([
        startMockHttpsServer({ tls: { key: certs.serverKey, cert: certs.serverCert } }),
        startMockHttpsServer({
          tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.caPem },
          requestCert: true,
        }),
        startMockHttpsServer({
          tls: { key: certs.serverKey, cert: certs.serverCert },
          maxVersion: 'TLSv1.2',
        }),
        startMockHttpsServer({
          tls: { key: certs.serverKey, cert: certs.serverCert },
          maxVersion: 'TLSv1.2',
          ciphers: PINNED_CIPHER,
        }),
      ]);
      await use({ https, mtls, tls12, cipherPinned, pinnedCipher: PINNED_CIPHER, certs });
      await Promise.all([https.close(), mtls.close(), tls12.close(), cipherPinned.close()]);
    },
    { scope: 'worker' },
  ],

  tls: async ({ _tls }, use) => {
    _tls.https.reset();
    _tls.mtls.reset();
    _tls.tls12.reset();
    _tls.cipherPinned.reset();
    await use(_tls);
  },
});

export { expect } from './electronApp';
