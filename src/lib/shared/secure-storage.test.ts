import { afterEach, describe, expect, it, vi } from 'vitest';
import { secureStorage } from './secure-storage';

describe('secureStorage', () => {
  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('awaits a sensitive value from Electron storage on the first read', async () => {
    const get = vi.fn(async () => 'persisted-secret');
    Object.defineProperty(window, 'electron', {
      value: {
        isElectron: true,
        store: { get, set: vi.fn(), delete: vi.fn(), clear: vi.fn() },
      },
      configurable: true,
    });

    await expect(secureStorage.getAsync('mqtt:restart:password')).resolves.toBe('persisted-secret');
    expect(get).toHaveBeenCalledWith('mqtt:restart:password');
  });

  describe('plaintext migration', () => {
    const KEY = 'kafka:tls-passphrase';
    const flush = () => new Promise((r) => setTimeout(r, 0));

    function installElectron(set: () => Promise<void>) {
      Object.defineProperty(window, 'electron', {
        value: {
          isElectron: true,
          store: { get: vi.fn(async () => undefined), set, delete: vi.fn(), clear: vi.fn() },
        },
        configurable: true,
      });
    }

    afterEach(() => {
      localStorage.clear();
    });

    it('keeps the plaintext copy when the encrypted write fails (sync get)', async () => {
      localStorage.setItem(KEY, 'legacy');
      installElectron(() => Promise.reject(new Error('safeStorage unavailable')));
      expect(secureStorage.get(KEY)).toBe('legacy');
      await flush();
      expect(localStorage.getItem(KEY)).toBe('legacy');
    });

    it('keeps the plaintext copy when the encrypted write fails (getAsync)', async () => {
      localStorage.setItem(`${KEY}2`, 'legacy');
      installElectron(() => Promise.reject(new Error('boom')));
      await expect(secureStorage.getAsync(`${KEY}2`)).resolves.toBe('legacy');
      expect(localStorage.getItem(`${KEY}2`)).toBe('legacy');
    });

    it('purges the plaintext copy once the encrypted write succeeded', async () => {
      localStorage.setItem(`${KEY}3`, 'legacy');
      installElectron(() => Promise.resolve());
      expect(secureStorage.get(`${KEY}3`)).toBe('legacy');
      await flush();
      expect(localStorage.getItem(`${KEY}3`)).toBeNull();
    });

    it('set() keeps any older plaintext until the encrypted write lands', async () => {
      localStorage.setItem(`${KEY}4`, 'old');
      installElectron(() => Promise.reject(new Error('boom')));
      secureStorage.set(`${KEY}4`, 'new');
      await flush();
      expect(localStorage.getItem(`${KEY}4`)).toBe('old');
    });
  });
});
