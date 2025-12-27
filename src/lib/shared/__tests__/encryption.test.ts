import { describe, it, expect } from 'vitest';
import {
  encryptValue,
  decryptValue,
  isEncrypted,
  encryptSensitiveFields,
  decryptSensitiveFields,
  SENSITIVE_FIELDS,
  generateLocalEncryptionKey,
  parseEncryptionKey,
  validateEncryptionKey,
  shouldRotateKey,
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

  describe('generateLocalEncryptionKey', () => {
    it('should generate a versioned key with correct format', () => {
      const key = generateLocalEncryptionKey();

      // Should start with version prefix
      expect(key.startsWith('v1:')).toBe(true);

      // Should contain algorithm
      expect(key.includes('aes-gcm:')).toBe(true);

      // Should have hex key (64 characters for 256 bits)
      const parts = key.split(':');
      expect(parts.length).toBe(3);
      expect(parts[2]?.length).toBe(64);
    });

    it('should generate unique keys each time', () => {
      const key1 = generateLocalEncryptionKey();
      const key2 = generateLocalEncryptionKey();

      expect(key1).not.toBe(key2);
    });

    it('should generate cryptographically strong keys', () => {
      const key = generateLocalEncryptionKey();
      const parsed = parseEncryptionKey(key);

      // Key should be 64 hex characters (256 bits)
      expect(parsed?.key.length).toBe(64);

      // Key should only contain valid hex characters
      expect(/^[0-9a-f]+$/.test(parsed?.key ?? '')).toBe(true);
    });
  });

  describe('parseEncryptionKey', () => {
    it('should parse versioned keys correctly', () => {
      const key = 'v1:aes-gcm:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      const parsed = parseEncryptionKey(key);

      expect(parsed).not.toBeNull();
      expect(parsed?.version).toBe(1);
      expect(parsed?.algorithm).toBe('aes-gcm');
      expect(parsed?.key).toBe('abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
    });

    it('should handle legacy keys (pre-versioning)', () => {
      const legacyKey = 'some-legacy-key-without-version';
      const parsed = parseEncryptionKey(legacyKey);

      expect(parsed).not.toBeNull();
      expect(parsed?.version).toBe(0);
      expect(parsed?.algorithm).toBe('legacy');
      expect(parsed?.key).toBe(legacyKey);
    });

    it('should return null for malformed keys', () => {
      expect(parseEncryptionKey('v1:')).toBeNull();
      expect(parseEncryptionKey('v1:only-one-part')).toBeNull();
    });

    it('should handle keys with colons in the value', () => {
      const key = 'v1:aes-gcm:key:with:colons';
      const parsed = parseEncryptionKey(key);

      expect(parsed?.key).toBe('key:with:colons');
    });
  });

  describe('validateEncryptionKey', () => {
    it('should validate correct versioned keys', () => {
      const key = generateLocalEncryptionKey();
      const result = validateEncryptionKey(key);

      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should reject empty keys', () => {
      expect(validateEncryptionKey('').valid).toBe(false);
      expect(validateEncryptionKey('').reason).toBe('Key is empty');
    });

    it('should reject keys with insufficient entropy', () => {
      const shortKey = 'v1:aes-gcm:short';
      const result = validateEncryptionKey(shortKey);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Key entropy too low');
    });

    it('should accept legacy keys', () => {
      // Legacy keys are accepted but flagged for rotation
      const legacyKey = 'some-old-legacy-key';
      const result = validateEncryptionKey(legacyKey);

      expect(result.valid).toBe(true);
    });
  });

  describe('shouldRotateKey', () => {
    it('should recommend rotation for legacy keys', () => {
      const legacyKey = 'navigator.userAgent|en-US|1920|1080|0|abc123';
      expect(shouldRotateKey(legacyKey)).toBe(true);
    });

    it('should not recommend rotation for current version keys', () => {
      const currentKey = generateLocalEncryptionKey();
      expect(shouldRotateKey(currentKey)).toBe(false);
    });

    it('should recommend rotation for older version keys', () => {
      // Simulate an older version key
      const oldVersionKey = 'v0:aes-gcm:' + 'a'.repeat(64);
      expect(shouldRotateKey(oldVersionKey)).toBe(true);
    });

    it('should recommend rotation for invalid keys', () => {
      expect(shouldRotateKey('')).toBe(true);
      expect(shouldRotateKey('v1:')).toBe(true);
    });
  });
});
