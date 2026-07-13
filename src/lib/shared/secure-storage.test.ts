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
});
