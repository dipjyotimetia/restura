/**
 * Client-side encryption utilities for sensitive data in localStorage
 * Uses Web Crypto API for AES-GCM encryption
 */

// Check if Web Crypto API is available
const isCryptoAvailable = typeof window !== 'undefined' && window.crypto && window.crypto.subtle;

// Encryption key derivation settings
const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH = 256;

/**
 * Generate a random salt
 */
function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
}

/**
 * Generate a random initialization vector
 */
function generateIV(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(IV_LENGTH));
}

/**
 * Derive an encryption key from a password using PBKDF2
 */
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);

  const keyMaterial = await crypto.subtle.importKey('raw', passwordBuffer, 'PBKDF2', false, [
    'deriveKey',
  ]);

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Convert ArrayBuffer to Base64 string
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

/**
 * Convert Base64 string to ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Encrypt a string value
 */
export async function encryptValue(value: string, password: string): Promise<string> {
  if (!isCryptoAvailable) {
    console.warn('Web Crypto API not available, storing data unencrypted');
    return value;
  }

  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(value);

    const salt = generateSalt();
    const iv = generateIV();
    const key = await deriveKey(password, salt);

    const encryptedData = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, data);

    // Combine salt + iv + encrypted data
    const combined = new Uint8Array(salt.length + iv.length + encryptedData.byteLength);
    combined.set(salt, 0);
    combined.set(iv, salt.length);
    combined.set(new Uint8Array(encryptedData), salt.length + iv.length);

    // Return as base64 with prefix to identify encrypted data
    return 'ENC:' + arrayBufferToBase64(combined.buffer);
  } catch (error) {
    console.error('Encryption failed:', error);
    throw new Error('Failed to encrypt data');
  }
}

/**
 * Decrypt a string value
 */
export async function decryptValue(encryptedValue: string, password: string): Promise<string> {
  if (!isCryptoAvailable) {
    console.warn('Web Crypto API not available');
    return encryptedValue;
  }

  // Check if data is encrypted
  if (!encryptedValue.startsWith('ENC:')) {
    // Data is not encrypted, return as-is
    return encryptedValue;
  }

  try {
    const base64Data = encryptedValue.substring(4); // Remove 'ENC:' prefix
    const combined = new Uint8Array(base64ToArrayBuffer(base64Data));

    // Extract salt, iv, and encrypted data
    const salt = combined.slice(0, SALT_LENGTH);
    const iv = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const encryptedData = combined.slice(SALT_LENGTH + IV_LENGTH);

    const key = await deriveKey(password, salt);

    const decryptedData = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encryptedData);

    const decoder = new TextDecoder();
    return decoder.decode(decryptedData);
  } catch (error) {
    console.error('Decryption failed:', error);
    throw new Error('Failed to decrypt data. Incorrect password or corrupted data.');
  }
}

/**
 * Generate a secure random password for local encryption
 * Uses device fingerprint and user-provided salt
 */
export function generateLocalEncryptionKey(): string {
  if (!isCryptoAvailable) {
    // Fallback for environments without Web Crypto
    return 'fallback-key-' + Date.now().toString(36);
  }

  // Use a combination of browser/device information
  const parts = [
    navigator.userAgent,
    navigator.language,
    screen.width.toString(),
    screen.height.toString(),
    new Date().getTimezoneOffset().toString(),
    // Add a random component for additional entropy
    Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(''),
  ];

  return parts.join('|');
}

/**
 * Check if a value is encrypted
 */
export function isEncrypted(value: string): boolean {
  return value.startsWith('ENC:');
}

/**
 * Encrypt sensitive authentication data
 */
export async function encryptAuthConfig(auth: unknown, password: string): Promise<string> {
  const jsonString = JSON.stringify(auth);
  return encryptValue(jsonString, password);
}

/**
 * Decrypt sensitive authentication data
 */
export async function decryptAuthConfig(
  encryptedAuth: string,
  password: string
): Promise<unknown> {
  const jsonString = await decryptValue(encryptedAuth, password);
  return JSON.parse(jsonString);
}

/**
 * Secure storage wrapper that automatically encrypts sensitive fields
 */
export const secureStorage = {
  encryptionKey: '', // Should be set by the application

  setEncryptionKey(key: string): void {
    this.encryptionKey = key;
  },

  async setItem(key: string, value: string, encrypt = false): Promise<void> {
    if (typeof window === 'undefined') return;

    try {
      let storedValue = value;
      if (encrypt && this.encryptionKey) {
        storedValue = await encryptValue(value, this.encryptionKey);
      }
      localStorage.setItem(key, storedValue);
    } catch (error) {
      console.error(`Failed to store item ${key}:`, error);
      throw error;
    }
  },

  async getItem(key: string): Promise<string | null> {
    if (typeof window === 'undefined') return null;

    try {
      const value = localStorage.getItem(key);
      if (!value) return null;

      // Auto-decrypt if encrypted
      if (isEncrypted(value) && this.encryptionKey) {
        return await decryptValue(value, this.encryptionKey);
      }
      return value;
    } catch (error) {
      console.error(`Failed to retrieve item ${key}:`, error);
      return null;
    }
  },

  removeItem(key: string): void {
    if (typeof window === 'undefined') return;
    localStorage.removeItem(key);
  },

  clear(): void {
    if (typeof window === 'undefined') return;
    localStorage.clear();
  },
};

// List of sensitive fields that should be encrypted
export const SENSITIVE_FIELDS = [
  'password',
  'token',
  'secret',
  'apiKey',
  'accessKey',
  'secretKey',
  'accessToken',
  'credentials',
];

/**
 * Recursively encrypt sensitive fields in an object
 */
export async function encryptSensitiveFields(
  obj: Record<string, unknown>,
  password: string
): Promise<Record<string, unknown>> {
  if (!isCryptoAvailable || !password) {
    return obj;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      result[key] = value;
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      result[key] = await encryptSensitiveFields(value as Record<string, unknown>, password);
    } else if (Array.isArray(value)) {
      result[key] = await Promise.all(
        value.map(async (item) => {
          if (typeof item === 'object' && item !== null) {
            return encryptSensitiveFields(item as Record<string, unknown>, password);
          }
          return item;
        })
      );
    } else if (
      typeof value === 'string' &&
      SENSITIVE_FIELDS.some((field) => key.toLowerCase().includes(field.toLowerCase()))
    ) {
      // Encrypt sensitive string fields
      result[key] = await encryptValue(value, password);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Recursively decrypt sensitive fields in an object
 */
export async function decryptSensitiveFields(
  obj: Record<string, unknown>,
  password: string
): Promise<Record<string, unknown>> {
  if (!isCryptoAvailable || !password) {
    return obj;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      result[key] = value;
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      result[key] = await decryptSensitiveFields(value as Record<string, unknown>, password);
    } else if (Array.isArray(value)) {
      result[key] = await Promise.all(
        value.map(async (item) => {
          if (typeof item === 'object' && item !== null) {
            return decryptSensitiveFields(item as Record<string, unknown>, password);
          }
          return item;
        })
      );
    } else if (typeof value === 'string' && isEncrypted(value)) {
      // Decrypt encrypted fields
      try {
        result[key] = await decryptValue(value, password);
      } catch {
        // If decryption fails, keep the encrypted value
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}
