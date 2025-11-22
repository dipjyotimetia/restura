import { describe, it, expect } from 'vitest';
import {
  encryptValue,
  decryptValue,
  isEncrypted,
  encryptSensitiveFields,
  decryptSensitiveFields,
  SENSITIVE_FIELDS,
} from '../encryption';

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

  describe('SENSITIVE_FIELDS', () => {
    it('should contain common sensitive field names', () => {
      expect(SENSITIVE_FIELDS).toContain('password');
      expect(SENSITIVE_FIELDS).toContain('token');
      expect(SENSITIVE_FIELDS).toContain('secret');
      expect(SENSITIVE_FIELDS).toContain('apiKey');
      expect(SENSITIVE_FIELDS).toContain('accessKey');
      expect(SENSITIVE_FIELDS).toContain('secretKey');
    });
  });

  describe('encryptSensitiveFields', () => {
    it('should encrypt sensitive string fields', async () => {
      const obj = {
        username: 'john',
        password: 'secret123',
        email: 'john@example.com',
      };

      const encrypted = await encryptSensitiveFields(obj, testPassword);

      expect(encrypted.username).toBe('john');
      expect(encrypted.email).toBe('john@example.com');
      expect(typeof encrypted.password === 'string' && encrypted.password.startsWith('ENC:')).toBe(true);
      expect(encrypted.password).not.toContain('secret123');
    });

    it('should handle nested objects', async () => {
      const obj = {
        user: {
          name: 'john',
          credentials: {
            apiKey: 'key-123',
            secretKey: 'secret-456',
          },
        },
      };

      const encrypted = await encryptSensitiveFields(obj, testPassword);

      expect((encrypted.user as Record<string, unknown>).name).toBe('john');
      const creds = (encrypted.user as Record<string, unknown>)
        .credentials as Record<string, unknown>;
      expect(typeof creds.apiKey === 'string' && creds.apiKey.startsWith('ENC:')).toBe(true);
      expect(typeof creds.secretKey === 'string' && creds.secretKey.startsWith('ENC:')).toBe(true);
    });

    it('should handle arrays', async () => {
      const obj = {
        tokens: [{ token: 'abc123' }, { token: 'def456' }],
      };

      const encrypted = await encryptSensitiveFields(obj, testPassword);
      const tokens = encrypted.tokens as Array<Record<string, unknown>>;

      expect(typeof tokens[0]?.token === 'string' && tokens[0].token.startsWith('ENC:')).toBe(true);
      expect(typeof tokens[1]?.token === 'string' && tokens[1].token.startsWith('ENC:')).toBe(true);
    });

    it('should handle null and undefined values', async () => {
      const obj = {
        password: null,
        token: undefined,
        apiKey: '',
      };

      const encrypted = await encryptSensitiveFields(obj, testPassword);

      expect(encrypted.password).toBeNull();
      expect(encrypted.token).toBeUndefined();
      expect(typeof encrypted.apiKey === 'string' && encrypted.apiKey.startsWith('ENC:')).toBe(true);
    });
  });

  describe('decryptSensitiveFields', () => {
    it('should decrypt encrypted fields', async () => {
      const obj = {
        username: 'john',
        password: 'secret123',
        token: 'token-abc',
      };

      const encrypted = await encryptSensitiveFields(obj, testPassword);
      const decrypted = await decryptSensitiveFields(encrypted, testPassword);

      expect(decrypted.username).toBe('john');
      expect(decrypted.password).toBe('secret123');
      expect(decrypted.token).toBe('token-abc');
    });

    it('should handle nested encrypted fields', async () => {
      const obj = {
        auth: {
          basic: {
            username: 'user',
            password: 'pass123',
          },
          bearer: {
            token: 'jwt-token',
          },
        },
      };

      const encrypted = await encryptSensitiveFields(obj, testPassword);
      const decrypted = await decryptSensitiveFields(encrypted, testPassword);

      const auth = decrypted.auth as Record<string, Record<string, unknown>>;
      expect(auth.basic?.password).toBe('pass123');
      expect(auth.bearer?.token).toBe('jwt-token');
    });

    it('should handle mixed encrypted and plain values', async () => {
      const obj = {
        name: 'plain',
        password: await encryptValue('encrypted', testPassword),
        count: 42,
      };

      const decrypted = await decryptSensitiveFields(obj, testPassword);

      expect(decrypted.name).toBe('plain');
      expect(decrypted.password).toBe('encrypted');
      expect(decrypted.count).toBe(42);
    });
  });
});
