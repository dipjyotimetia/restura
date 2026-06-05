// @vitest-environment node
//
// Key-management policy (security-critical): prefer safeStorage (OS keychain),
// fall back to a 0o600 plaintext file with a loud warning, and surface an
// aggregated keychain status. Module state accumulates across calls, so each
// test re-imports a fresh module via vi.resetModules.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { fsMock, safeStorageMock } = vi.hoisted(() => ({
  fsMock: {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
  },
  safeStorageMock: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => b.toString().replace(/^enc:/, '')),
  },
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-userData') },
  safeStorage: safeStorageMock,
}));
vi.mock('fs', () => fsMock);
vi.mock('../../../src/lib/shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const ENOENT = () => Object.assign(new Error('missing'), { code: 'ENOENT' });

async function freshModule() {
  vi.resetModules();
  // `.js` specifier satisfies nodenext's extension rule for dynamic imports;
  // Vitest resolves it back to the .ts source at runtime.
  return import('../encrypted-key.js');
}

beforeEach(() => {
  Object.values(fsMock).forEach((f) => f.mockReset());
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
  safeStorageMock.encryptString.mockImplementation((s: string) => Buffer.from(`enc:${s}`));
  safeStorageMock.decryptString.mockImplementation((b: Buffer) =>
    b.toString().replace(/^enc:/, '')
  );
});

describe('getOrCreateEncryptedKey', () => {
  const opts = { fileName: 'k.bin', storeLabel: 'creds' };

  it('generates and encrypts a new key when none exists and keychain is available', async () => {
    fsMock.readFileSync.mockImplementation(() => {
      throw ENOENT();
    });
    const { getOrCreateEncryptedKey } = await freshModule();

    const key = getOrCreateEncryptedKey(opts);
    expect(key).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, hex
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith(key);
    expect(fsMock.writeFileSync).toHaveBeenCalled();
  });

  it('returns the decrypted key when an encrypted file already exists', async () => {
    fsMock.readFileSync.mockReturnValue(Buffer.from('enc:deadbeef'));
    const { getOrCreateEncryptedKey, getKeyStoreStatus } = await freshModule();

    expect(getOrCreateEncryptedKey(opts)).toBe('deadbeef');
    expect(getKeyStoreStatus().mode).toBe('safeStorage');
  });

  it('falls back to plaintext (and flags status) when no keychain is available', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    fsMock.readFileSync.mockImplementation(() => {
      throw ENOENT();
    });
    const { getOrCreateEncryptedKey, getKeyStoreStatus } = await freshModule();

    const key = getOrCreateEncryptedKey(opts);
    // Written as plaintext with 0o600 mode.
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(expect.any(String), key, { mode: 0o600 });
    const status = getKeyStoreStatus();
    expect(status.mode).toBe('plaintext');
    expect(status.reason).toBe('no-keyring');
    expect(status.plaintextStores).toContain('creds');
  });

  it('regenerates a fresh key when an existing encrypted key fails to decrypt', async () => {
    fsMock.readFileSync.mockReturnValue(Buffer.from('corrupt'));
    safeStorageMock.decryptString.mockImplementationOnce(() => {
      throw new Error('bad blob');
    });
    const { getOrCreateEncryptedKey, getKeyStoreStatus } = await freshModule();

    const key = getOrCreateEncryptedKey(opts);
    // Decrypt failed → a fresh key is generated and (keychain still available)
    // re-encrypted, so the store recovers to safeStorage mode.
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith(key);
    expect(getKeyStoreStatus().mode).toBe('safeStorage');
  });

  it('reports safeStorage mode when every store is protected', async () => {
    fsMock.readFileSync.mockReturnValue(Buffer.from('enc:abc'));
    const { getOrCreateEncryptedKey, getKeyStoreStatus } = await freshModule();
    getOrCreateEncryptedKey({ fileName: 'a.bin', storeLabel: 'A' });
    getOrCreateEncryptedKey({ fileName: 'b.bin', storeLabel: 'B' });
    expect(getKeyStoreStatus()).toMatchObject({ mode: 'safeStorage', plaintextStores: [] });
  });
});
