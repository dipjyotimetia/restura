/**
 * Variable status — e2e coverage for the `{{var}}` "Unresolved variable"
 * overlay (`useVariableStatus` → `VariableText` / body-summary chips).
 *
 * Regression guard for the false-positive fix: variables defined at COLLECTION
 * scope and variables SET BY A PRE-REQUEST SCRIPT resolve correctly on the wire
 * but used to be flagged as unresolved because the classifier only checked the
 * active environment. Here we import a collection whose request references a
 * collection variable (`{{colVar}}`), a script-set variable (`{{scriptVar}}`),
 * and a genuinely-undefined one (`{{nope}}`) across the URL, params, headers,
 * and body — then assert each section flags ONLY `nope`.
 *
 * Clean Dexie + localStorage per test via `resetPersistedState`
 * (`playwright.config.ts` runs workers:1, fullyParallel:false).
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { mockProxy } from './utils/mockProxy';
import { resetPersistedState } from './utils/reset-state';
import { sendButton } from './utils/selectors';

// Local tab locators (non-exact): the shared `paramsTab` helper matches the tab
// name exactly, which breaks once a tab shows a count badge — our imported
// request has 2 params and 2 headers, so the accessible name becomes "Params2".
const builderTab = (page: Page, name: 'Params' | 'Headers' | 'Body') =>
  page.getByRole('tab', { name: new RegExp(`^${name}`) });

const COLLECTION = {
  info: {
    name: 'VarStatus Collection',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [{ key: 'colVar', value: 'https://api.example.com' }],
  item: [
    {
      name: 'VarStatus Request',
      event: [
        {
          listen: 'prerequest',
          script: { type: 'text/javascript', exec: ["pm.environment.set('scriptVar', 'sv')"] },
        },
      ],
      request: {
        method: 'GET',
        header: [
          { key: 'X-Col', value: '{{colVar}}' },
          { key: 'X-Bad', value: '{{nope}}' },
        ],
        body: { mode: 'raw', raw: '{"u":"{{colVar}}","bad":"{{nope}}"}' },
        url: {
          raw: '{{colVar}}/path?q={{scriptVar}}&bad={{nope}}',
          host: ['{{colVar}}'],
          path: ['path'],
          query: [
            { key: 'q', value: '{{scriptVar}}' },
            { key: 'bad', value: '{{nope}}' },
          ],
        },
      },
    },
  ],
};

const unresolved = (page: Page, name: string) => page.getByTitle(`Unresolved variable: ${name}`);

/** Assert the fixed scopes are NOT flagged and the undefined one IS. */
async function assertScopes(page: Page) {
  await expect(unresolved(page, 'nope')).toBeVisible();
  await expect(unresolved(page, 'colVar')).toHaveCount(0);
  await expect(unresolved(page, 'scriptVar')).toHaveCount(0);
}

test.describe('Variable status overlay', () => {
  test.beforeEach(async ({ app: page }) => {
    await resetPersistedState(page);
  });

  test('collection + script-set vars are not flagged across sections; unknowns are', async ({
    app: page,
  }) => {
    // Import the collection via the Import dialog (Postman is the default format).
    await page.getByRole('button', { name: 'Import collection' }).click();
    await expect(page.getByRole('dialog', { name: 'Import collection' })).toBeVisible();
    await page.locator('#file-upload-postman').setInputFiles({
      name: 'var-status.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(COLLECTION)),
    });

    // Open the request from the sidebar tree so the tab carries `savedRequestId`
    // (the link the classifier uses to find the collection's variables).
    await page.getByText('VarStatus Request').first().click();

    // URL bar (always visible): colVar + scriptVar resolved, nope flagged.
    await assertScopes(page);

    // Each request-builder section renders its own overlays.
    await builderTab(page, 'Params').click();
    await assertScopes(page);

    await builderTab(page, 'Headers').click();
    await assertScopes(page);

    await builderTab(page, 'Body').click();
    // Body tab also renders the aggregated "Vars" summary chips.
    await assertScopes(page);
    await expect(page.getByText('{{colVar}}', { exact: true }).first()).toBeVisible();

    // Design guard: the marker clearing and actual substitution are different
    // code paths — assert the collection value truly reaches the wire, not just
    // that the overlay stopped flagging it.
    let sentUrl = '';
    await mockProxy(page, (req) => {
      sentUrl = req.url;
      return { status: 200, body: '{}' };
    });
    await sendButton(page).click();
    await expect.poll(() => sentUrl).toContain('https://api.example.com/path');
    expect(sentUrl).not.toContain('{{colVar}}');
  });
});
