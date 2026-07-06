import { describe, it, expect } from 'vitest';
import { looksLikePemCertificate, looksLikePemPrivateKey } from './pemValidation';

const CERT = `-----BEGIN CERTIFICATE-----\nMIIB...abc\n-----END CERTIFICATE-----`;
const PKCS8_KEY = `-----BEGIN PRIVATE KEY-----\nMIIE...xyz\n-----END PRIVATE KEY-----`;
const RSA_KEY = `-----BEGIN RSA PRIVATE KEY-----\nMIIE...xyz\n-----END RSA PRIVATE KEY-----`;
const EC_KEY = `-----BEGIN EC PRIVATE KEY-----\nMHc...xyz\n-----END EC PRIVATE KEY-----`;
const ENCRYPTED_KEY = `-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIF...xyz\n-----END ENCRYPTED PRIVATE KEY-----`;

describe('looksLikePemCertificate', () => {
  it('accepts a PEM certificate block', () => {
    expect(looksLikePemCertificate(CERT)).toBe(true);
  });
  it('accepts a certificate embedded in surrounding whitespace/text', () => {
    expect(looksLikePemCertificate(`bag attributes\n${CERT}\n`)).toBe(true);
  });
  it('rejects a private key', () => {
    expect(looksLikePemCertificate(PKCS8_KEY)).toBe(false);
  });
  it('rejects empty / junk input', () => {
    expect(looksLikePemCertificate('')).toBe(false);
    expect(looksLikePemCertificate('not a cert')).toBe(false);
  });
});

describe('looksLikePemPrivateKey', () => {
  it('accepts PKCS#8, RSA, EC, and encrypted keys', () => {
    expect(looksLikePemPrivateKey(PKCS8_KEY)).toBe(true);
    expect(looksLikePemPrivateKey(RSA_KEY)).toBe(true);
    expect(looksLikePemPrivateKey(EC_KEY)).toBe(true);
    expect(looksLikePemPrivateKey(ENCRYPTED_KEY)).toBe(true);
  });
  it('rejects a certificate', () => {
    expect(looksLikePemPrivateKey(CERT)).toBe(false);
  });
  it('rejects empty / junk input', () => {
    expect(looksLikePemPrivateKey('')).toBe(false);
    expect(looksLikePemPrivateKey('password123')).toBe(false);
  });
});
