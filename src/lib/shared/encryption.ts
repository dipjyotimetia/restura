/**
 * Client-side encryption utilities for sensitive data at rest.
 * Uses the Web Crypto API for AES-GCM encryption (PBKDF2-derived key).
 * The core encrypt/decrypt helpers back the Dexie/IndexedDB storage adapter.
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

    const encryptedData = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      data
    );

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
  } catch {
    // Don't log here — the caller (e.g. dexie-storage.getItem) decides how to
    // handle and report a decryption failure, avoiding a duplicate console line.
    throw new Error('Failed to decrypt data. Incorrect password or corrupted data.');
  }
}

/**
 * Generate a secure random password for local encryption
 */
export function generateLocalEncryptionKey(): string {
  if (!isCryptoAvailable) {
    // Fallback for environments without Web Crypto
    return `fallback-key-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Check if a value is encrypted
 */
export function isEncrypted(value: string): boolean {
  return value.startsWith('ENC:');
}

// NOTE: this module used to also export a localStorage-based `secureStorage`
// wrapper plus password-based auth-config/sensitive-field helpers. All were
// dead code superseded by src/lib/shared/secure-storage.ts (the sanctioned
// storage router) and the SecretRef handle pattern (ADR-0007), and were
// removed — don't reintroduce renderer-side password crypto here.
