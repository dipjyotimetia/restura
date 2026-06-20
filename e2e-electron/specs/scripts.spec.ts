import { test, expect } from '../fixtures/servers';
import type { Page } from '@playwright/test';
import { switchMode, setUrl, sendButton } from '../../e2e/utils/selectors';

/**
 * Desktop pre-request scripts (QuickJS sandbox) on the interactive Send path.
 * A pre-request script that sets a variable must make it available for {{var}}
 * substitution in the request — the canonical Postman pattern (compute a token
 * / timestamp before sending). echo's /echo reflects the wire query string, so
 * a substituted value proves the script's mutation reached the request.
 *
 * Regression guard: the interactive hook resolved the request with the env-store
 * resolver only, ignoring the local envVars map that pre-request script mutations
 * land in (the shared executor mirrors this via `resolveLocal`). So script-set
 * vars were silently dropped on the interactive Send — fixed to mirror the
 * executor. (fail-when-broken: a dropped var leaves the literal {{scriptVar}}.)
 */
async function fillVisibleMonaco(page: Page, value: string): Promise<void> {
  const editor = page.locator('.monaco-editor').filter({ visible: true }).first();
  const ok = await editor.evaluate((node: Element, v: string) => {
    const host = node.parentElement ?? node;
    const fiberKey = Object.keys(host).find((k) => k.startsWith('__reactFiber$'));
    let fiber: unknown = fiberKey
      ? (host as unknown as Record<string, unknown>)[fiberKey]
      : undefined;
    while (fiber) {
      const props = (fiber as { memoizedProps?: { onChange?: unknown } }).memoizedProps;
      if (typeof props?.onChange === 'function') {
        (props.onChange as (val: string) => void)(v);
        return true;
      }
      fiber = (fiber as { return?: unknown }).return;
    }
    return false;
  }, value);
  if (!ok) throw new Error('Could not reach the script editor onChange handler');
}

test.describe('Desktop pre-request scripts', () => {
  test('a pre-request script variable is substituted into the request', async ({
    app: page,
    servers,
  }) => {
    await switchMode(page, 'http');

    await page.getByRole('tab', { name: 'Scripts', exact: true }).click();
    await fillVisibleMonaco(page, "pm.environment.set('scriptVar', 'from-script');");
    // Confirm the script registered on the active request before sending
    // (the Pre-request tab shows a "has script" indicator once non-empty).
    await expect(page.getByLabel('has script').first()).toBeVisible();

    await setUrl(page, `${servers.http.url}/echo?v={{scriptVar}}`);
    await page.keyboard.press('Escape'); // dismiss the {{var}} suggestion popover
    await sendButton(page).click();

    // Poll the recorded requests until the /echo send lands — don't key off the
    // response "200" badge, which can be stale from a prior test in the shared
    // window. A recorded path with v=from-script proves the script's variable
    // was substituted onto the wire.
    await expect
      .poll(() => servers.http.requests().find((r) => r.path.startsWith('/echo'))?.path ?? '', {
        timeout: 10_000,
      })
      .toContain('v=from-script');
    const echo = servers.http.requests().find((r) => r.path.startsWith('/echo'));
    expect(echo!.path).not.toContain('scriptVar');
  });
});
