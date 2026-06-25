import { test, expect } from '../fixtures/servers';
import type { Page } from '@playwright/test';
import { switchMode, setUrl, sendButton } from '../../e2e/utils/selectors';

/**
 * Desktop AI inline actions + Agent Mode against a LOCAL mock LLM.
 *
 * The mock `/v1/chat/completions` (e2e/mocks/httpServer.ts) routes off the
 * request body: the inline-action seeded prompts name a tool, so it streams the
 * matching OpenAI tool-call delta; Agent Mode's first turn (agent system prompt)
 * gets a `set_test_script` proposal and the continuation turn ("previous step
 * was applied") gets a final no-tool reply → the loop terminates. This drives
 * the full propose-&-apply path end-to-end with no cloud key.
 */

/** Configure the chat's local OpenAI-compatible provider in Settings → AI. */
async function configureLocalAi(page: Page, baseUrl: string): Promise<void> {
  await page.getByRole('button', { name: 'Open settings' }).click();
  const drawer = page.getByRole('dialog', { name: 'Settings' });
  await drawer.getByRole('button', { name: 'AI', exact: true }).click();
  await drawer.getByRole('combobox').first().click();
  await page.getByRole('option', { name: /OpenAI-compatible/i }).click();
  await drawer.getByPlaceholder('http://localhost:11434').fill(baseUrl);
  await drawer.getByPlaceholder(/local model id/).fill('mock-model');
  await drawer.getByRole('button', { name: 'Save local provider' }).click();
  await page.getByRole('button', { name: 'Close settings' }).click();
}

async function closeAiPanel(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: 'Close AI panel' })
    .click()
    .catch(() => {});
}

test.describe('Desktop AI inline actions + Agent Mode', () => {
  test('Generate tests: inline action proposes set_test_script and Apply writes it', async ({
    app: page,
    servers,
  }) => {
    await switchMode(page, 'http');
    await configureLocalAi(page, servers.http.url);

    try {
      // Scripts → Test sub-tab exposes the "Generate tests" inline action.
      await page.getByRole('tab', { name: 'Scripts', exact: true }).click();
      await page.getByRole('radio', { name: 'Test' }).click();
      await page.getByRole('button', { name: 'Generate tests' }).click();

      // The seeded prompt names set_test_script → the mock streams that tool
      // call → it surfaces as a proposal card in the (auto-opened) AI panel.
      await expect(page.getByText('set_test_script').first()).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: 'Apply', exact: true }).click();

      // Applying runs the tool against the active request and surfaces a success
      // toast — a deterministic signal independent of which tab/sub-tab renders.
      await expect(page.getByText(/Updated the active request/i).first()).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await closeAiPanel(page);
    }
  });

  test('Fix request: response-header AI menu proposes update_http_request and Apply rewrites the URL', async ({
    app: page,
    servers,
  }) => {
    await switchMode(page, 'http');
    await configureLocalAi(page, servers.http.url);

    try {
      // Send a request so the response viewer (which hosts the AI actions menu) renders.
      await setUrl(page, `${servers.http.url}/json`);
      await sendButton(page).click();
      await expect(page.getByText('200').first()).toBeVisible({ timeout: 15_000 });

      // Open the response-header AI menu and pick "Fix request".
      await page.getByRole('button', { name: 'AI actions' }).click();
      await page.getByRole('menuitem', { name: 'Fix request' }).click();

      await expect(page.getByText('update_http_request').first()).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: 'Apply', exact: true }).click();

      // The mock's correction sets the URL; the URL field must reflect it.
      await expect(page.getByRole('textbox', { name: 'Request URL' })).toHaveValue(
        'https://fixed.example/ok',
        { timeout: 10_000 }
      );
    } finally {
      await closeAiPanel(page);
    }
  });

  test('Agent Mode: proposes a step, Apply continues the loop, and it reaches completion', async ({
    app: page,
    servers,
  }) => {
    await switchMode(page, 'http');
    await configureLocalAi(page, servers.http.url);

    try {
      await page.getByRole('button', { name: 'Toggle AI chat' }).click();
      await page.getByRole('button', { name: 'Agent mode' }).click();

      const goal = page.getByRole('textbox', { name: 'Agent goal' });
      await expect(goal).toBeEnabled({ timeout: 10_000 });
      await goal.fill('add a status test for this request');
      await page.getByRole('button', { name: 'Start', exact: true }).click();

      // First turn proposes one step (set_test_script).
      await expect(page.getByText('set_test_script').first()).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: 'Apply', exact: true }).click();

      // Applying advances the loop; the continuation turn returns a final,
      // tool-less reply → the agent banner reports completion.
      await expect(page.getByText('Goal complete').first()).toBeVisible({ timeout: 20_000 });
    } finally {
      await closeAiPanel(page);
    }
  });
});
