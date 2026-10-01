import { expect, test } from '../fixtures/electronApp';

/**
 * File-menu tab commands reach the renderer as menu events: Close Tab
 * (CmdOrCtrl+W), Reopen Closed Tab (CmdOrCtrl+Shift+T) and New Request.
 * Clicks go through the real application menu, as an accelerator would.
 */
async function clickFileMenuItem(
  electronApp: import('@playwright/test').ElectronApplication,
  label: string
) {
  await electronApp.evaluate(({ BrowserWindow, Menu }, itemLabel) => {
    const file = Menu.getApplicationMenu()?.items.find((item) => item.label === 'File');
    const item = file?.submenu?.items.find((entry) => entry.label === itemLabel);
    if (!item) throw new Error(`File menu has no "${itemLabel}" item`);
    item.click(undefined, BrowserWindow.getAllWindows()[0], undefined as never);
  }, label);
}

test('File menu closes, reopens and creates request tabs', async ({ app: page, _electronApp }) => {
  const { electronApp } = _electronApp;
  const tabs = page.getByRole('tablist', { name: 'Request tabs' }).getByRole('tab');
  const before = await tabs.count();

  await clickFileMenuItem(electronApp, 'New Request');
  await expect(tabs).toHaveCount(before + 1);

  await clickFileMenuItem(electronApp, 'Close Tab');
  await expect(tabs).toHaveCount(before);

  await clickFileMenuItem(electronApp, 'Reopen Closed Tab');
  await expect(tabs).toHaveCount(before + 1);

  // The window-close role moved off Cmd/Ctrl+W.
  const closeAccelerator = await electronApp.evaluate(({ Menu }) => {
    const all = Menu.getApplicationMenu()?.items.flatMap((m) => m.submenu?.items ?? []) ?? [];
    return all.find((item) => item.role === 'close')?.accelerator ?? null;
  });
  expect(closeAccelerator).toBe('CmdOrCtrl+Shift+W');
});
