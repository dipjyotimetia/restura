// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// encrypted-key reads `safeStorage` + `app.getPath` from electron at runtime.
// Mirror the surface it touches (self-contained — __tests__/setup.ts is not
// auto-loaded for this file).
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-userData') },
  safeStorage: {
    isEncryptionAvailable: vi.fn(),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
}));

import * as fs from 'fs';
import { safeStorage } from 'electron';
import { getOrCreateEncryptedKey, getKeyStoreStatus } from '../encrypted-key';

const enoent = (): NodeJS.ErrnoException => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
const HEX64 = /^[0-9a-f]{64}$/;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getOrCreateEncryptedKey', () => {
  it('generates + safeStorage-encrypts a new key on first run', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw enoent();
    });
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
    vi.mocked(safeStorage.encryptString).mockReturnValue(Buffer.from('cipher'));

    const key = getOrCreateEncryptedKey({ fileName: 'k1.bin', storeLabel: 'store-1' });

    expect(key).toMatch(HEX64);
    expect(safeStorage.encryptString).toHaveBeenCalledWith(key);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/tmp/test-userData/k1.bin',
      Buffer.from('cipher')
    );
    expect(getKeyStoreStatus().plaintextStores).not.toContain('store-1');
  });

  it('falls back to a 0o600 plaintext key file when no OS keyring is available', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw enoent();
    });
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);

    const key = getOrCreateEncryptedKey({ fileName: 'k2.bin', storeLabel: 'store-2' });

    expect(key).toMatch(HEX64);
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalledWith('/tmp/test-userData/k2.bin', key, {
      mode: 0o600,
    });
    const status = getKeyStoreStatus();
    expect(status.mode).toBe('plaintext');
    expect(status.plaintextStores).toContain('store-2');
    expect(status.reason).toBe('no-keyring');
  });

  it('decrypts and returns an existing safeStorage key without rewriting it', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('existing-cipher'));
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
    vi.mocked(safeStorage.decryptString).mockReturnValue('decrypted-key');

    const key = getOrCreateEncryptedKey({ fileName: 'k3.bin', storeLabel: 'store-3' });

    expect(key).toBe('decrypted-key');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.chmodSync).toHaveBeenCalledWith('/tmp/test-userData/k3.bin', 0o600);
    expect(getKeyStoreStatus().plaintextStores).not.toContain('store-3');
  });

  it('reads an existing plaintext key file verbatim when no keyring is available', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('plain-key-hex'));
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);

    const key = getOrCreateEncryptedKey({ fileName: 'k4.bin', storeLabel: 'store-4' });

    expect(key).toBe('plain-key-hex');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(getKeyStoreStatus().plaintextStores).toContain('store-4');
  });

  it('regenerates a fresh key when an existing safeStorage blob fails to decrypt', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('corrupt-cipher'));
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
    vi.mocked(safeStorage.decryptString).mockImplementation(() => {
      throw new Error('bad');
    });
    vi.mocked(safeStorage.encryptString).mockReturnValue(Buffer.from('cipher2'));

    const key = getOrCreateEncryptedKey({ fileName: 'k5.bin', storeLabel: 'store-5' });

    expect(key).toMatch(HEX64);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/tmp/test-userData/k5.bin',
      Buffer.from('cipher2')
    );
  });
});
