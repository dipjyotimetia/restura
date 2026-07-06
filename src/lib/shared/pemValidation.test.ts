import { describe, it, expect } from 'vitest';
import { looksLikePemCertificate, looksLikePemPrivateKey } from './pemValidation';

const CERT = `-----BEGIN CERTIFICATE-----\nMIIB...abc\n-----END CERTIFICATE-----`;
const TRUSTED_CERT = `-----BEGIN TRUSTED CERTIFICATE-----\nMIIB...abc\n-----END TRUSTED CERTIFICATE-----`;
const PKCS8_KEY = `-----BEGIN PRIVATE KEY-----\nMIIE...xyz\n-----END PRIVATE KEY-----`;
const RSA_KEY = `-----BEGIN RSA PRIVATE KEY-----\nMIIE...xyz\n-----END RSA PRIVATE KEY-----`;
const EC_KEY = `-----BEGIN EC PRIVATE KEY-----\nMHc...xyz\n-----END EC PRIVATE KEY-----`;
const DSA_KEY = `-----BEGIN DSA PRIVATE KEY-----\nMIIB...xyz\n-----END DSA PRIVATE KEY-----`;
const OPENSSH_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNz...\n-----END OPENSSH PRIVATE KEY-----`;
const ENCRYPTED_KEY = `-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIF...xyz\n-----END ENCRYPTED PRIVATE KEY-----`;
const MISMATCHED_KEY = `-----BEGIN RSA PRIVATE KEY-----\nMIIE...xyz\n-----END EC PRIVATE KEY-----`;

describe('looksLikePemCertificate', () => {
  it('accepts a PEM certificate block', () => {
    expect(looksLikePemCertificate(CERT)).toBe(true);
  });
  it('accepts an OpenSSL TRUSTED CERTIFICATE block', () => {
    expect(looksLikePemCertificate(TRUSTED_CERT)).toBe(true);
  });
  it('accepts a certificate embedded in surrounding whitespace/text', () => {
    expect(looksLikePemCertificate(`bag attributes\n${CERT}\n`)).toBe(true);
  });
  it('rejects a private key', () => {
    expect(looksLikePemCertificate(PKCS8_KEY)).toBe(false);
  });
  it('rejects a mismatched BEGIN/END label', () => {
    expect(
      looksLikePemCertificate(`-----BEGIN CERTIFICATE-----\nx\n-----END TRUSTED CERTIFICATE-----`)
    ).toBe(false);
  });
  it('rejects empty / junk input', () => {
    expect(looksLikePemCertificate('')).toBe(false);
    expect(looksLikePemCertificate('not a cert')).toBe(false);
  });
});

describe('looksLikePemPrivateKey', () => {
  it('accepts PKCS#8, RSA, EC, DSA, OpenSSH, and encrypted keys', () => {
    expect(looksLikePemPrivateKey(PKCS8_KEY)).toBe(true);
    expect(looksLikePemPrivateKey(RSA_KEY)).toBe(true);
    expect(looksLikePemPrivateKey(EC_KEY)).toBe(true);
    expect(looksLikePemPrivateKey(DSA_KEY)).toBe(true);
    expect(looksLikePemPrivateKey(OPENSSH_KEY)).toBe(true);
    expect(looksLikePemPrivateKey(ENCRYPTED_KEY)).toBe(true);
  });
  it('rejects a mismatched BEGIN/END label', () => {
    expect(looksLikePemPrivateKey(MISMATCHED_KEY)).toBe(false);
  });
  it('rejects a certificate', () => {
    expect(looksLikePemPrivateKey(CERT)).toBe(false);
  });
  it('rejects empty / junk input', () => {
    expect(looksLikePemPrivateKey('')).toBe(false);
    expect(looksLikePemPrivateKey('password123')).toBe(false);
  });
});
