/**
 * Environment Manager — e2e coverage for the redesigned dialog
 * (`src/features/environments/components/EnvironmentManager.tsx`).
 *
 * Tests are written against the new Spatial-Depth chrome:
 *   - Dialog `aria-label="Environments"` (no longer "ENVIRONMENTS")
 *   - Split footer: separate "Set as active" + "Close" buttons
 *   - Selection vs. active are visually distinct ("Active" pill on the
 *     active row; `aria-current="true"` on the selected row)
 *   - Empty state ships 3 one-click scaffolds (Local / Staging / Production)
 *
 * Each test starts from a clean Dexie + localStorage state via
 * `resetPersistedState` so envs don't bleed across tests
 * (`playwright.config.ts` runs `workers: 1, fullyParallel: false`).
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { resetPersistedState } from './utils/reset-state';

function dialog(page: Page) {
  return page.getByRole('dialog', { name: 'Environments' });
}

async function openManager(page: Page) {
  // Header env pill — "Switch environment (current: <name>)" — opens the
  // Environment Manager dialog directly (the sidebar footer + quick-switch
  // popover were removed when the env indicator was de-duplicated).
  await page.getByRole('button', { name: /Switch environment/ }).click();
  await expect(dialog(page)).toBeVisible();
}

/** Scaffold buttons live ONLY in the EmptyState (rendered when no envs exist). */
function scaffoldButton(page: Page, name: 'Local' | 'Staging' | 'Production') {
  return dialog(page).getByRole('button').filter({ hasText: name }).first();
}

/** A list row in the left rail — `role="button"` with the env name + subtitle. */
function envRow(page: Page, envName: string) {
  return dialog(page).locator('[role="button"]').filter({ hasText: envName }).first();
}

/** The header rename trigger — uniquely identified by its title attribute. */
function renameTrigger(page: Page) {
  return dialog(page).locator('button[title="Click to rename"]');
}

async function createScaffoldThenCloseReopen(page: Page, name: 'Local' | 'Staging' | 'Production') {
  await openManager(page);
  await scaffoldButton(page, name).click();
  await dialog(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog(page)).not.toBeVisible();
  await openManager(page);
}

test.describe('Environment Manager', () => {
  test.beforeEach(async ({ app: page }) => {
    await resetPersistedState(page);
  });

  test('empty state renders three scaffolds + create-blank CTA', async ({ app: page }) => {
    await openManager(page);

    await expect(dialog(page).getByRole('heading', { name: 'No environments yet' })).toBeVisible();
    await expect(scaffoldButton(page, 'Local')).toBeVisible();
    await expect(scaffoldButton(page, 'Staging')).toBeVisible();
    await expect(scaffoldButton(page, 'Production')).toBeVisible();
    await expect(
      dialog(page).getByRole('button', { name: 'Create blank environment' })
    ).toBeVisible();
  });

  test('scaffold creates an env, shows it in the list, dialog stays open', async ({
    app: page,
  }) => {
    await openManager(page);
    await scaffoldButton(page, 'Staging').click();

    // Detail header reflects the new env (rename trigger contains the name).
    await expect(renameTrigger(page)).toContainText('Staging');
    // List row appears.
    await expect(envRow(page, 'Staging')).toBeVisible();
    // Dialog must still be visible (no auto-close on create).
    await expect(dialog(page)).toBeVisible();
  });

  test('selection vs active: setting active keeps the dialog open', async ({ app: page }) => {
    // Bootstrap one env via the EmptyState scaffold, then close + reopen so
    // the rail's "New environment" button is what we use for the second env.
    await createScaffoldThenCloseReopen(page, 'Local');

    // Local is auto-selected. Active is null (scaffold doesn't set active).
    // Add a second env via the rail.
    await dialog(page).getByRole('button', { name: 'New environment' }).click();

    // The newly created env auto-selects. "Set as active" should be enabled.
    const setActive = dialog(page).getByRole('button', { name: 'Set as active' });
    await expect(setActive).toBeEnabled();
    await setActive.click();

    // Dialog must stay open after the click.
    await expect(dialog(page)).toBeVisible();
    // Button now reads "Active" and is disabled.
    await expect(dialog(page).getByRole('button', { name: 'Active', exact: true })).toBeDisabled();
  });

  test('Close button dismisses without changing active env', async ({ app: page }) => {
    await createScaffoldThenCloseReopen(page, 'Local');
    await dialog(page).getByRole('button', { name: 'Set as active' }).click();
    // Now Local is active. Add a second env, select it, but DON'T set active.
    await dialog(page).getByRole('button', { name: 'New environment' }).click();
    await expect(dialog(page).getByRole('button', { name: 'Set as active' })).toBeEnabled();

    // Close — the header env pill should still read "Local" as the active env.
    await dialog(page).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog(page)).not.toBeVisible();
    await expect(
      page.getByRole('button', { name: /Switch environment \(current: Local\)/ })
    ).toBeVisible();
  });

  test('inline rename on detail header commits on Enter', async ({ app: page }) => {
    await openManager(page);
    await scaffoldButton(page, 'Local').click();

    await renameTrigger(page).click();
    // After click, the renameTrigger button is replaced by an input. The
    // detail header has exactly one input at this point.
    const input = dialog(page).locator('input').first();
    await input.fill('Local Renamed');
    await input.press('Enter');

    await expect(renameTrigger(page)).toContainText('Local Renamed');
  });

  test('dropdown menu offers Rename, Duplicate, Delete', async ({ app: page }) => {
    await openManager(page);
    await scaffoldButton(page, 'Local').click();

    await dialog(page).getByRole('button', { name: 'Environment actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Duplicate' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible();

    // Duplicate → "<name> (copy)" appears + selects.
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect(renameTrigger(page)).toContainText('Local (copy)');
    await expect(envRow(page, 'Local (copy)')).toBeVisible();
  });

  test('row hover delete asks for confirmation, then removes the env', async ({ app: page }) => {
    await createScaffoldThenCloseReopen(page, 'Local');
    // Add a second env so the rail isn't empty after deletion.
    await dialog(page).getByRole('button', { name: 'New environment' }).click();

    const localRow = envRow(page, 'Local');
    await localRow.hover();
    await localRow.getByRole('button', { name: /Delete Local/ }).click();

    // ConfirmDialog appears outside the manager dialog as an alertdialog.
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete', exact: true })
      .click();

    // The deleted row should disappear from the rail.
    await expect(envRow(page, 'Local')).toHaveCount(0);
  });

  test('search input appears once four envs exist and filters by name', async ({ app: page }) => {
    await openManager(page);
    await scaffoldButton(page, 'Local').click();
    // 1 env. Add 3 more via the rail to reach 4 — the threshold for search.
    for (let i = 0; i < 3; i++) {
      await dialog(page).getByRole('button', { name: 'New environment' }).click();
    }
    const search = dialog(page).getByPlaceholder('Search environments…');
    await expect(search).toBeVisible();

    await search.fill('Local');
    await expect(envRow(page, 'Local')).toBeVisible();
    await expect(dialog(page).getByText(/Environment 2/)).toHaveCount(0);

    await search.fill('');
    await expect(envRow(page, 'Environment 2')).toBeVisible();
  });

  test('Usage tabs swap explainer content', async ({ app: page }) => {
    await openManager(page);
    await scaffoldButton(page, 'Local').click();

    // Default tab — {{variable}} — explains how variable references work.
    await expect(dialog(page).getByText(/Reference a variable from anywhere/)).toBeVisible();

    await dialog(page).getByRole('tab', { name: '{{$dynamic}}' }).click();
    await expect(dialog(page).getByText(/Built-in helpers expand at send time/)).toBeVisible();

    await dialog(page).getByRole('tab', { name: 'Secrets', exact: true }).click();
    await expect(dialog(page).getByText(/OS keychain/)).toBeVisible();
  });
});
