// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// encrypted-key reads `safeStorage` + `app.getPath` from electron at runtime.
// Mirror the surface it touches (self-contained — __tests__/setup.ts is not
// auto-loaded for this file).
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-userData') },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(),
    encryptStringAsync: vi.fn(),
    decryptStringAsync: vi.fn(),
  },
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
}));

import { safeStorage } from 'electron';
import * as fs from 'fs';
import {
  __resetPrimedKeysForTests,
  deriveEncryptedKey,
  getKeyStoreStatus,
  getOrCreateEncryptedKey,
  primeEncryptedKeys,
} from '../security/encrypted-key';

const enoent = (): NodeJS.ErrnoException => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
const HEX64 = /^[0-9a-f]{64}$/;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('deriveEncryptedKey', () => {
  it('generates + safeStorage-encrypts a new key on first run', async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw enoent();
    });
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
    vi.mocked(safeStorage.encryptStringAsync).mockResolvedValue(Buffer.from('cipher'));

    const key = await deriveEncryptedKey({ fileName: 'k1.bin', storeLabel: 'store-1' });

    expect(key).toMatch(HEX64);
    expect(safeStorage.encryptStringAsync).toHaveBeenCalledWith(key);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/tmp/test-userData/k1.bin',
      Buffer.from('cipher')
    );
    expect(getKeyStoreStatus().plaintextStores).not.toContain('store-1');
  });

  it('falls back to a 0o600 plaintext key file when no OS keyring is available', async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw enoent();
    });
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);

    const key = await deriveEncryptedKey({ fileName: 'k2.bin', storeLabel: 'store-2' });

    expect(key).toMatch(HEX64);
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalledWith('/tmp/test-userData/k2.bin', key, {
      mode: 0o600,
    });
    const status = getKeyStoreStatus();
    expect(status.mode).toBe('plaintext');
    expect(status.plaintextStores).toContain('store-2');
    expect(status.reason).toBe('no-keyring');
  });

  it('decrypts and returns an existing safeStorage key without rewriting it', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('existing-cipher'));
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
    vi.mocked(safeStorage.decryptStringAsync).mockResolvedValue({
      result: 'decrypted-key',
      shouldReEncrypt: false,
    });

    const key = await deriveEncryptedKey({ fileName: 'k3.bin', storeLabel: 'store-3' });

    expect(key).toBe('decrypted-key');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.chmodSync).toHaveBeenCalledWith('/tmp/test-userData/k3.bin', 0o600);
    expect(getKeyStoreStatus().plaintextStores).not.toContain('store-3');
  });

  it('reads an existing plaintext key file verbatim when no keyring is available', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('plain-key-hex'));
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);

    const key = await deriveEncryptedKey({ fileName: 'k4.bin', storeLabel: 'store-4' });

    expect(key).toBe('plain-key-hex');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(getKeyStoreStatus().plaintextStores).toContain('store-4');
  });

  it('regenerates a fresh key when an existing safeStorage blob fails to decrypt', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('corrupt-cipher'));
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
    vi.mocked(safeStorage.decryptStringAsync).mockRejectedValue(new Error('bad'));
    vi.mocked(safeStorage.encryptStringAsync).mockResolvedValue(Buffer.from('cipher2'));

    const key = await deriveEncryptedKey({ fileName: 'k5.bin', storeLabel: 'store-5' });

    expect(key).toMatch(HEX64);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/tmp/test-userData/k5.bin',
      Buffer.from('cipher2')
    );
  });
});

describe('primeEncryptedKeys / getOrCreateEncryptedKey', () => {
  beforeEach(() => {
    __resetPrimedKeysForTests();
  });

  it('throws for a key that was never primed (no silent second key)', () => {
    expect(() => getOrCreateEncryptedKey({ fileName: 'p0.bin', storeLabel: 'store-p0' })).toThrow(
      /not primed/
    );
  });

  it('serves primed keys synchronously, one per key file', async () => {
    vi.mocked(fs.readFileSync).mockImplementation((file) => {
      if (String(file).endsWith('p1.bin')) return Buffer.from('cipher-1');
      if (String(file).endsWith('p2.bin')) return Buffer.from('cipher-2');
      throw enoent();
    });
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
    vi.mocked(safeStorage.decryptStringAsync).mockImplementation(async (b) => ({
      result: `key-of-${b.toString()}`,
      shouldReEncrypt: false,
    }));

    await primeEncryptedKeys([
      { fileName: 'p1.bin', storeLabel: 'store-p1' },
      { fileName: 'p2.bin', storeLabel: 'store-p2' },
    ]);

    expect(getOrCreateEncryptedKey({ fileName: 'p1.bin', storeLabel: 'store-p1' })).toBe(
      'key-of-cipher-1'
    );
    expect(getOrCreateEncryptedKey({ fileName: 'p2.bin', storeLabel: 'store-p2' })).toBe(
      'key-of-cipher-2'
    );
  });
});
