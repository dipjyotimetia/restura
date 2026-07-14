import { describe, expect, it } from 'vitest';
import { decryptValue, encryptValue, generateLocalEncryptionKey, isEncrypted } from '../encryption';

describe('Encryption Utilities', () => {
  const testPassword = 'test-password-123';

  describe('encryptValue and decryptValue', () => {
    it('should encrypt and decrypt a simple string', async () => {
      const originalValue = 'Hello, World!';
      const encrypted = await encryptValue(originalValue, testPassword);

      expect(encrypted.startsWith('ENC:')).toBe(true);
      expect(encrypted).not.toContain(originalValue);

      const decrypted = await decryptValue(encrypted, testPassword);
      expect(decrypted).toBe(originalValue);
    });

    it('should encrypt and decrypt JSON data', async () => {
      const originalValue = JSON.stringify({ key: 'value', number: 42 });
      const encrypted = await encryptValue(originalValue, testPassword);
      const decrypted = await decryptValue(encrypted, testPassword);
      expect(decrypted).toBe(originalValue);
    });

    it('should produce different ciphertext for same input', async () => {
      const value = 'same-value';
      const encrypted1 = await encryptValue(value, testPassword);
      const encrypted2 = await encryptValue(value, testPassword);

      // Different due to random salt and IV
      expect(encrypted1).not.toBe(encrypted2);

      // But both should decrypt to same value
      const decrypted1 = await decryptValue(encrypted1, testPassword);
      const decrypted2 = await decryptValue(encrypted2, testPassword);
      expect(decrypted1).toBe(value);
      expect(decrypted2).toBe(value);
    });

    it('should fail to decrypt with wrong password', async () => {
      const originalValue = 'secret data';
      const encrypted = await encryptValue(originalValue, testPassword);

      await expect(decryptValue(encrypted, 'wrong-password')).rejects.toThrow();
    });

    it('should return unencrypted value if not encrypted', async () => {
      const plainValue = 'not encrypted';
      const result = await decryptValue(plainValue, testPassword);
      expect(result).toBe(plainValue);
    });

    it('should throw error for truncated ciphertext', async () => {
      const originalValue = 'secret data';
      const encrypted = await encryptValue(originalValue, testPassword);

      // Truncate the encrypted value
      const truncated = encrypted.slice(0, Math.floor(encrypted.length / 2));

      await expect(decryptValue(truncated, testPassword)).rejects.toThrow();
    });

    it('should throw error for corrupted ciphertext', async () => {
      const originalValue = 'secret data';
      const encrypted = await encryptValue(originalValue, testPassword);

      // Corrupt the middle of the ciphertext
      const chars = encrypted.split('');
      const middleIndex = Math.floor(chars.length / 2);
      chars[middleIndex] = chars[middleIndex] === 'A' ? 'B' : 'A';
      const corrupted = chars.join('');

      await expect(decryptValue(corrupted, testPassword)).rejects.toThrow();
    });

    it('should throw error for malformed ENC: prefix with invalid base64', async () => {
      // Valid prefix but invalid base64 content
      const malformed = 'ENC:!!!invalid-base64!!!';

      await expect(decryptValue(malformed, testPassword)).rejects.toThrow();
    });

    it('should throw error for ENC: prefix with too short data', async () => {
      // ENC prefix but data too short to contain salt + iv + ciphertext
      const tooShort = 'ENC:YWJj'; // "abc" in base64

      await expect(decryptValue(tooShort, testPassword)).rejects.toThrow();
    });

    it('should handle empty string', async () => {
      const encrypted = await encryptValue('', testPassword);
      const decrypted = await decryptValue(encrypted, testPassword);
      expect(decrypted).toBe('');
    });

    it('should handle unicode characters', async () => {
      const originalValue = '你好世界 🌍 مرحبا';
      const encrypted = await encryptValue(originalValue, testPassword);
      const decrypted = await decryptValue(encrypted, testPassword);
      expect(decrypted).toBe(originalValue);
    });

    it('should handle long strings', async () => {
      const originalValue = 'x'.repeat(10000);
      const encrypted = await encryptValue(originalValue, testPassword);
      const decrypted = await decryptValue(encrypted, testPassword);
      expect(decrypted).toBe(originalValue);
    });
  });

  describe('isEncrypted', () => {
    it('should identify encrypted values', () => {
      expect(isEncrypted('ENC:abc123')).toBe(true);
    });

    it('should identify non-encrypted values', () => {
      expect(isEncrypted('plain text')).toBe(false);
      expect(isEncrypted('')).toBe(false);
      expect(isEncrypted('encryption')).toBe(false);
    });
  });

  describe('generateLocalEncryptionKey', () => {
    it('generates random 256-bit hex keys without browser fingerprint material', () => {
      const key1 = generateLocalEncryptionKey();
      const key2 = generateLocalEncryptionKey();

      expect(key1).toMatch(/^[a-f0-9]{64}$/);
      expect(key2).toMatch(/^[a-f0-9]{64}$/);
      expect(key1).not.toBe(key2);
    });
  });

  describe('removed legacy surface stays removed', () => {
    it('does not re-export the localStorage-based secureStorage or password-crypto helpers', async () => {
      // The old `secureStorage` here duplicated src/lib/shared/secure-storage.ts
      // (the sanctioned storage router) and leaked through the barrel export;
      // the sensitive-field helpers encouraged renderer-side password crypto
      // superseded by SecretRef handles (ADR-0007).
      const mod = await import('../encryption');
      expect(mod).not.toHaveProperty('secureStorage');
      expect(mod).not.toHaveProperty('encryptSensitiveFields');
      expect(mod).not.toHaveProperty('decryptSensitiveFields');
      expect(mod).not.toHaveProperty('encryptAuthConfig');
      expect(mod).not.toHaveProperty('decryptAuthConfig');
      expect(mod).not.toHaveProperty('SENSITIVE_FIELDS');
    });
  });
});
