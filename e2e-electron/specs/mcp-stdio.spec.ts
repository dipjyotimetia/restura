import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { switchMode } from '../../e2e/utils/selectors';
import { expect, test } from '../fixtures/electronApp';

const FIXTURE = path.resolve(__dirname, '../fixtures/mcp-stdio-server.mjs');

/** PIDs of running fixture servers (POSIX only; Windows returns null → skip the check). */
function fixturePids(): number[] | null {
  if (process.platform === 'win32') return null;
  try {
    return execFileSync('pgrep', ['-f', 'mcp-stdio-server.mjs'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

/**
 * Desktop MCP stdio smoke (#854): renderer → IPC → main consent gate (native
 * dialog, stubbed here in MAIN — the renderer has no way to answer it) → SDK
 * StdioClientTransport spawn → real stdio MCP server fixture. Proves the
 * prompt fires once per new command line, discovery works, stderr reaches the
 * UI, and Disconnect kills the child process.
 */
test.describe('Desktop MCP stdio transport', () => {
  // The app is shared across specs and Electron answers renderer window.confirm
  // through dialog.showMessageBox, so a leftover stub auto-accepts later specs'
  // confirms before Playwright sees them. Put the original back.
  test.afterEach(async ({ _electronApp }) => {
    await _electronApp.electronApp.evaluate(({ dialog }) => {
      const g = globalThis as unknown as {
        __originalShowMessageBox?: typeof dialog.showMessageBox;
      };
      if (g.__originalShowMessageBox) dialog.showMessageBox = g.__originalShowMessageBox;
      delete g.__originalShowMessageBox;
    });
  });

  test('consent, discovery, stderr, and kill-on-disconnect', async ({
    app: page,
    _electronApp,
  }) => {
    const { electronApp } = _electronApp;
    // Answer the main-process consent dialog with its most permissive button:
    // "Always allow" when approvals can be remembered (OS keychain present),
    // otherwise "Allow once" (Linux CI without a keyring: safeStorage is
    // unavailable, so main deliberately offers only Cancel / Allow once).
    await electronApp.evaluate(({ dialog }) => {
      const g = globalThis as unknown as {
        __stdioPrompts: string[][];
        __originalShowMessageBox?: typeof dialog.showMessageBox;
      };
      g.__stdioPrompts = [];
      g.__originalShowMessageBox ??= dialog.showMessageBox;
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { buttons?: string[] };
        const buttons = options.buttons ?? [];
        g.__stdioPrompts.push(buttons);
        return { response: buttons.length - 1, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });
    const prompts = () =>
      electronApp.evaluate(
        () => (globalThis as unknown as { __stdioPrompts: string[][] }).__stdioPrompts
      );

    expect(fixturePids() ?? []).toEqual([]);

    await switchMode(page, 'mcp');
    await page.getByRole('radio', { name: 'stdio' }).click();
    await page
      .getByPlaceholder('Command, e.g. npx or /usr/local/bin/my-mcp-server')
      .fill(process.execPath);
    await page.getByRole('button', { name: /Launch settings/ }).click();
    await page.getByLabel('stdio arguments').fill(FIXTURE);

    await page.getByRole('button', { name: /Connect/i }).click();
    const catalog = page.getByRole('button', { name: 'Tools', exact: true });
    if ((await catalog.getAttribute('aria-pressed')) !== 'true') await catalog.click();
    await expect(page.getByRole('tab', { name: /Tools\s+5/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('env-keys', { exact: true }).first()).toBeVisible();
    const first = await prompts();
    expect(first).toHaveLength(1);
    expect(first[0]?.[0]).toBe('Cancel');
    const remembered = first[0]?.includes('Always allow') ?? false;

    await expect(page.getByLabel('MCP server stderr')).toContainText('restura stdio fixture ready');
    const running = fixturePids();
    if (running) expect(running).toHaveLength(1);

    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    if (running) await expect.poll(() => fixturePids(), { timeout: 10_000 }).toEqual([]);

    // Reconnect the identical command line. With "Always allow" it must not
    // prompt again; without a keychain every launch prompts (fail closed).
    await page.getByRole('button', { name: /Connect/i }).click();
    await expect(page.getByRole('tab', { name: /Tools\s+5/ })).toBeVisible({ timeout: 20_000 });
    expect(await prompts()).toHaveLength(remembered ? 1 : 2);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    if (running) await expect.poll(() => fixturePids(), { timeout: 10_000 }).toEqual([]);
  });
});
