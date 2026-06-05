import { test, expect, type HarnessIpc } from './fixtures';

// Real IPC round-trips through the built app: renderer → preload → main handler
// → back. Offline-safe (no upstream network), so deterministic in CI.
test.describe('Electron IPC round-trips', () => {
  test('store set → get → has → delete', async ({ window }) => {
    const result = await window.evaluate(async () => {
      const s = (window as unknown as { electron: HarnessIpc }).electron.store;
      await s.set('e2e-key', 'e2e-value');
      const got = await s.get('e2e-key');
      const has = await s.has('e2e-key');
      await s.delete('e2e-key');
      const afterDelete = await s.get('e2e-key');
      return { got, has, afterDelete };
    });

    expect(result.got).toBe('e2e-value');
    expect(result.has).toBe(true);
    expect(result.afterDelete).toBeUndefined();
  });

  test('keychain.status returns a key-store mode', async ({ window }) => {
    const status = await window.evaluate(() =>
      (window as unknown as { electron: HarnessIpc }).electron.keychain.status()
    );
    // safeStorage may be unavailable on a headless CI runner — both modes are
    // valid; we only assert the IPC contract holds end-to-end.
    expect(status.mode === 'safeStorage' || status.mode === 'plaintext').toBe(true);
    expect(Array.isArray(status.plaintextStores)).toBe(true);
  });
});
