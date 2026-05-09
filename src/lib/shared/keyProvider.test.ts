import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EphemeralKeyProvider,
  WebSessionPassphraseProvider,
  ElectronSafeStorageKeyProvider,
  getKeyProvider,
  setKeyProvider,
  __resetKeyProviderForTests,
} from './keyProvider';

describe('EphemeralKeyProvider', () => {
  it('returns the same generated key across calls within a session', async () => {
    const p = new EphemeralKeyProvider();
    const a = await p.getKey();
    const b = await p.getKey();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(32);
  });

  it('isHardwareBacked returns false', () => {
    expect(new EphemeralKeyProvider().isHardwareBacked).toBe(false);
  });

  it('label is descriptive', () => {
    expect(new EphemeralKeyProvider().label).toMatch(/ephemeral/i);
  });
});

describe('WebSessionPassphraseProvider', () => {
  beforeEach(() => {
    WebSessionPassphraseProvider.reset();
  });

  it('throws if no passphrase has been set', async () => {
    const p = new WebSessionPassphraseProvider();
    await expect(p.getKey()).rejects.toThrow(/passphrase/i);
  });

  it('throws if setPassphrase called with empty string', async () => {
    const p = new WebSessionPassphraseProvider();
    await expect(p.setPassphrase('')).rejects.toThrow(/empty/i);
  });

  it('returns a derived key after setPassphrase', async () => {
    const p = new WebSessionPassphraseProvider();
    await p.setPassphrase('correct horse battery staple');
    const key = await p.getKey();
    expect(key).toBeTruthy();
    expect(key.length).toBe(64); // 32 bytes hex
  });

  it('two providers with same passphrase derive the same key (deterministic)', async () => {
    const p1 = new WebSessionPassphraseProvider();
    await p1.setPassphrase('hunter2');
    const k1 = await p1.getKey();
    WebSessionPassphraseProvider.reset();
    const p2 = new WebSessionPassphraseProvider();
    await p2.setPassphrase('hunter2');
    const k2 = await p2.getKey();
    expect(k1).toBe(k2);
  });

  it('different passphrases produce different keys', async () => {
    const p1 = new WebSessionPassphraseProvider();
    await p1.setPassphrase('foo');
    const k1 = await p1.getKey();
    WebSessionPassphraseProvider.reset();
    const p2 = new WebSessionPassphraseProvider();
    await p2.setPassphrase('bar');
    const k2 = await p2.getKey();
    expect(k1).not.toBe(k2);
  });

  it('isHardwareBacked returns false', () => {
    expect(new WebSessionPassphraseProvider().isHardwareBacked).toBe(false);
  });

  it('reset clears the singleton key', async () => {
    const p = new WebSessionPassphraseProvider();
    await p.setPassphrase('x');
    expect(await p.getKey()).toBeTruthy();
    WebSessionPassphraseProvider.reset();
    await expect(new WebSessionPassphraseProvider().getKey()).rejects.toThrow(/passphrase/i);
  });
});

describe('ElectronSafeStorageKeyProvider', () => {
  it('calls the secureKey IPC to fetch the persisted key', async () => {
    const get = vi.fn().mockResolvedValue('persisted-key-xxx');
    const has = vi.fn().mockResolvedValue(true);
    const set = vi.fn();
    const p = new ElectronSafeStorageKeyProvider({ get, set, has });
    const k = await p.getKey();
    expect(k).toBe('persisted-key-xxx');
    expect(has).toHaveBeenCalledWith('restura-encryption-key');
    expect(get).toHaveBeenCalledWith('restura-encryption-key');
    expect(set).not.toHaveBeenCalled();
  });

  it('generates and stores a new key on first run', async () => {
    const get = vi.fn();
    const has = vi.fn().mockResolvedValue(false);
    const set = vi.fn();
    const p = new ElectronSafeStorageKeyProvider({ get, set, has });
    const k = await p.getKey();
    expect(k.length).toBeGreaterThan(32);
    expect(set).toHaveBeenCalledWith('restura-encryption-key', k);
  });

  it('caches the key after first fetch (no repeat IPC calls)', async () => {
    const get = vi.fn().mockResolvedValue('persisted');
    const has = vi.fn().mockResolvedValue(true);
    const set = vi.fn();
    const p = new ElectronSafeStorageKeyProvider({ get, set, has });
    await p.getKey();
    await p.getKey();
    await p.getKey();
    expect(get).toHaveBeenCalledTimes(1);
    expect(has).toHaveBeenCalledTimes(1);
  });

  it('falls through to generation if has() is true but get() returns undefined', async () => {
    const get = vi.fn().mockResolvedValue(undefined);
    const has = vi.fn().mockResolvedValue(true);
    const set = vi.fn();
    const p = new ElectronSafeStorageKeyProvider({ get, set, has });
    const k = await p.getKey();
    expect(k.length).toBeGreaterThan(32);
    expect(set).toHaveBeenCalledWith('restura-encryption-key', k);
  });

  it('isHardwareBacked returns true', () => {
    const p = new ElectronSafeStorageKeyProvider({
      get: vi.fn(), set: vi.fn(), has: vi.fn(),
    });
    expect(p.isHardwareBacked).toBe(true);
  });

  it('label mentions OS keychain', () => {
    const p = new ElectronSafeStorageKeyProvider({
      get: vi.fn(), set: vi.fn(), has: vi.fn(),
    });
    expect(p.label).toMatch(/keychain|secure storage/i);
  });
});

describe('getKeyProvider / setKeyProvider', () => {
  beforeEach(() => {
    __resetKeyProviderForTests();
  });

  it('returns Ephemeral by default in test env (no Electron API)', () => {
    const provider = getKeyProvider();
    expect(provider).toBeInstanceOf(EphemeralKeyProvider);
  });

  it('caches the resolved provider across calls', () => {
    const a = getKeyProvider();
    const b = getKeyProvider();
    expect(a).toBe(b);
  });

  it('setKeyProvider overrides the cached selection', () => {
    const original = getKeyProvider();
    const replacement = new WebSessionPassphraseProvider();
    setKeyProvider(replacement);
    const after = getKeyProvider();
    expect(after).toBe(replacement);
    expect(after).not.toBe(original);
  });
});
