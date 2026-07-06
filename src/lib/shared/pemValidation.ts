/**
 * Lightweight structural checks for PEM certificate material pasted or loaded
 * in the certificate settings. These are *shape* checks, not full X.509 parses
 * — they catch the common "wrong file" / "empty paste" mistakes at save time so
 * the user gets actionable feedback instead of an opaque TLS handshake error at
 * request time. A value that passes these can still fail the real handshake
 * (expired, wrong key, bad chain); a value that fails them is definitely wrong.
 */

const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;
// Covers PKCS#8 (`PRIVATE KEY`), PKCS#1 RSA, SEC1 EC, and encrypted PKCS#8.
const PEM_KEY_RE =
  /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/;

/** True when the text contains at least one PEM certificate block. */
export function looksLikePemCertificate(text: string): boolean {
  return PEM_CERT_RE.test(text);
}

/** True when the text contains a PEM private-key block. */
export function looksLikePemPrivateKey(text: string): boolean {
  return PEM_KEY_RE.test(text);
}
