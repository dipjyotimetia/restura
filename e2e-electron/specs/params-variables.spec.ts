import { test, expect } from '../fixtures/servers';
import { switchMode, setUrl, sendButton } from '../../e2e/utils/selectors';

/**
 * Desktop query params + variable substitution on the interactive Send path.
 * `resolveVariables` runs renderer-side before the spec crosses IPC; echo's
 * `/echo` reflects the wire query string (and records it), so we can prove that
 * (a) a literal query param survives to the wire and (b) a built-in dynamic
 * variable is actually substituted. The dynamic-variable assertion is the
 * fail-when-broken guard: if substitution regresses, no UUID is produced and
 * the regex match fails (a literal `{{$randomUUID}}` would just be percent-
 * encoded, so the positive UUID match — not a `not.toContain` — is what bites).
 */
test.describe('Desktop params + variable substitution', () => {
  test('literal params survive and a dynamic variable resolves on the wire', async ({
    app: page,
    servers,
  }) => {
    await switchMode(page, 'http');
    await setUrl(page, `${servers.http.url}/echo?fixed=abc&id={{$randomUUID}}`);
    await page.keyboard.press('Escape'); // dismiss any variable-suggestion popover
    await sendButton(page).click();

    await expect(page.getByText('200', { exact: true }).first()).toBeVisible();

    const echo = servers.http.requests().find((r) => r.path.startsWith('/echo'));
    expect(echo, 'an /echo request was recorded').toBeTruthy();
    // Literal query param reached the wire unchanged.
    expect(echo!.path).toContain('fixed=abc');
    // The dynamic variable was resolved to a real UUID (fail-when-broken).
    expect(echo!.path).toMatch(/id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    // And the unresolved token did not survive in any form.
    expect(echo!.path).not.toMatch(/randomUUID/i);
  });
});
