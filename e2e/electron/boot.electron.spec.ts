import { test, expect } from './fixtures';

// The built app boots, paints a window, and exposes the preload bridge whose
// shape matches ElectronAPI. This is the end-to-end drift guard: if the preload
// or the renderer entry breaks, the desktop app ships a blank window — caught here.
test.describe('Electron app boot', () => {
  test('launches and renders the renderer over file://', async ({ window }) => {
    await expect(async () => {
      const url = window.url();
      expect(url).toMatch(/index\.html/);
    }).toPass();
    // The SPA mounts into #root.
    await expect(window.locator('#root')).toBeAttached();
  });

  test('exposes window.electron with the expected IPC surface', async ({ window }) => {
    const surface = await window.evaluate(() => {
      const e = (window as unknown as { electron?: Record<string, unknown> }).electron;
      return e ? { keys: Object.keys(e), isElectron: e.isElectron, platform: e.platform } : null;
    });

    expect(surface).not.toBeNull();
    expect(surface!.isElectron).toBe(true);
    expect(typeof surface!.platform).toBe('string');
    // A representative subset of the ElectronAPI top-level members.
    expect(surface!.keys).toEqual(
      expect.arrayContaining([
        'http',
        'grpc',
        'store',
        'keychain',
        'secrets',
        'window',
        'fs',
        'app',
      ])
    );
  });
});
