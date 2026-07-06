/**
 * Lightweight structural checks for PEM certificate material pasted or loaded
 * in the certificate settings. These are *shape* checks, not full X.509 parses
 * — they catch the common "wrong file" / "empty paste" mistakes at save time so
 * the user gets actionable feedback instead of an opaque TLS handshake error at
 * request time. A value that passes these can still fail the real handshake
 * (expired, wrong key, bad chain); a value that fails them is definitely wrong.
 */

// The label is captured and back-referenced on the END line so a mismatched
// block (e.g. BEGIN RSA … / END EC …) doesn't false-pass.
const PEM_CERT_RE = /-----BEGIN ((?:TRUSTED )?CERTIFICATE)-----[\s\S]+?-----END \1-----/;
// Any `<LABEL> PRIVATE KEY` block: PKCS#8 (`PRIVATE KEY`), PKCS#1 RSA, SEC1 EC,
// DSA, encrypted PKCS#8, and OpenSSH. A shape check — a label Node's TLS can't
// consume (e.g. OpenSSH) still surfaces at handshake, but an obvious wrong file
// (a cert, random text) is caught at save time.
const PEM_KEY_RE = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]+?-----END \1-----/;

/** True when the text contains at least one PEM certificate block. */
export function looksLikePemCertificate(text: string): boolean {
  return PEM_CERT_RE.test(text);
}

/** True when the text contains a PEM private-key block. */
export function looksLikePemPrivateKey(text: string): boolean {
  return PEM_KEY_RE.test(text);
}
