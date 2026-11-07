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
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  chmodSync: vi.fn(),
}));

import * as fs from 'node:fs';
import { safeStorage } from 'electron';
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
    const plain = 'ab'.repeat(32);
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from(plain));
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);

    const key = await deriveEncryptedKey({ fileName: 'k4.bin', storeLabel: 'store-4' });

    expect(key).toBe(plain);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(getKeyStoreStatus().plaintextStores).toContain('store-4');
  });

  it('migrates a plaintext key file to safeStorage once a keyring appears (same key, no reset)', async () => {
    const plain = 'cd'.repeat(32);
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from(plain));
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
    vi.mocked(safeStorage.encryptStringAsync).mockResolvedValue(Buffer.from('sealed-plain'));

    const key = await deriveEncryptedKey({ fileName: 'k6.bin', storeLabel: 'store-6' });

    expect(key).toBe(plain);
    expect(safeStorage.decryptStringAsync).not.toHaveBeenCalled();
    expect(safeStorage.encryptStringAsync).toHaveBeenCalledWith(plain);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/test-userData/k6.bin'),
      Buffer.from('sealed-plain'),
      { mode: 0o600 }
    );
    expect(fs.renameSync).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/test-userData/k6.bin'),
      '/tmp/test-userData/k6.bin'
    );
    expect(getKeyStoreStatus().plaintextStores).not.toContain('store-6');
  });

  it('keeps using a plaintext key if re-sealing it fails', async () => {
    const plain = 'ef'.repeat(32);
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from(plain));
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
    vi.mocked(safeStorage.encryptStringAsync).mockRejectedValue(new Error('locked'));

    const key = await deriveEncryptedKey({ fileName: 'k7.bin', storeLabel: 'store-7' });

    expect(key).toBe(plain);
    expect(fs.renameSync).not.toHaveBeenCalled();
    expect(getKeyStoreStatus().plaintextStores).toContain('store-7');
  });

  it.skipIf(process.platform !== 'linux')(
    'reports a basic_text-sealed key as unprotected while still using it',
    async () => {
      const ss = safeStorage as unknown as { getSelectedStorageBackend: () => string };
      ss.getSelectedStorageBackend = vi.fn(() => 'basic_text');
      try {
        vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('v10-basic'));
        vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
        vi.mocked(safeStorage.decryptStringAsync).mockResolvedValue({
          result: 'basic-key',
          shouldReEncrypt: false,
        });

        const key = await deriveEncryptedKey({ fileName: 'k9.bin', storeLabel: 'store-9' });

        expect(key).toBe('basic-key');
        expect(getKeyStoreStatus().plaintextStores).toContain('store-9');
      } finally {
        ss.getSelectedStorageBackend = vi.fn(() => 'gnome_libsecret');
      }
    }
  );

  it('fails closed when a sealed key file is read while the keyring is unavailable', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('v11\u0001ÿsealed-bytes'));
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);

    await expect(deriveEncryptedKey({ fileName: 'k8.bin', storeLabel: 'store-8' })).rejects.toThrow(
      /keychain/i
    );
    // Never overwrite the sealed key: the data stays readable once the keyring returns.
    expect(fs.writeFileSync).not.toHaveBeenCalled();
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

  it('primes healthy keys and surfaces the derivation error for a failed one', async () => {
    vi.mocked(fs.readFileSync).mockImplementation((file) => {
      if (String(file).endsWith('p3.bin')) return Buffer.from('12'.repeat(32));
      if (String(file).endsWith('p4.bin')) return Buffer.from('v10\u0000sealed');
      throw enoent();
    });
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);

    await expect(
      primeEncryptedKeys([
        { fileName: 'p3.bin', storeLabel: 'store-p3' },
        { fileName: 'p4.bin', storeLabel: 'store-p4' },
      ])
    ).rejects.toThrow(/keychain/i);

    expect(getOrCreateEncryptedKey({ fileName: 'p3.bin', storeLabel: 'store-p3' })).toBe(
      '12'.repeat(32)
    );
    expect(() => getOrCreateEncryptedKey({ fileName: 'p4.bin', storeLabel: 'store-p4' })).toThrow(
      /keychain/i
    );
  });
});
