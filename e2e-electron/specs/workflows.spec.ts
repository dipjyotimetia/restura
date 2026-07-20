import { setUrl, switchMode } from '../../e2e/utils/selectors';
import { expect, test } from '../fixtures/servers';

const WORKFLOW_DOCUMENT = {
  document: {
    dsl: '1.0.3',
    namespace: 'restura',
    name: 'desktop-ows-flow',
    version: '1.0.0',
  },
  do: [
    {
      initialize: {
        do: [
          { setContext: { set: { source: 'desktop-e2e' } } },
          { boundedDelay: { wait: { milliseconds: 1 } } },
        ],
      },
    },
    {
      callSavedRequest: {
        call: 'http',
        with: {
          method: 'GET',
          endpoint: { uri: 'restura://saved-request' },
        },
      },
    },
  ],
};

const WORKFLOW_BINDINGS = {
  version: 1,
  tasks: {
    '/do/1/callSavedRequest': {
      kind: 'saved-request',
      call: 'http',
      resourceId: 'Workflow%20request',
    },
  },
};

async function createCollectionAndSavedRequest(
  page: Parameters<typeof setUrl>[0],
  url: string
): Promise<void> {
  await switchMode(page, 'http');
  await setUrl(page, url);
  const requestTab = page
    .getByRole('tablist', { name: 'Request tabs' })
    .getByRole('tab', { selected: true });
  await requestTab.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Save to Collection…' }).click();

  const saveDialog = page.getByRole('dialog', { name: 'Save to Collection' });
  await saveDialog.getByPlaceholder('Request name').fill('Workflow request');
  const newMode = saveDialog.getByRole('button', { name: 'New' });
  if (await newMode.count()) await newMode.click();
  await saveDialog.getByPlaceholder('New collection name').fill(`Workflow E2E ${Date.now()}`);
  await saveDialog.getByRole('button', { name: 'Save' }).click();
}

test.describe('Desktop OWS workflows', () => {
  test('authors and runs every supported OWS control through the native HTTP path', async ({
    app: page,
    servers,
  }) => {
    await createCollectionAndSavedRequest(page, `${servers.http.url}/json`);

    await page.getByRole('tab', { name: 'Workflows', exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: 'Workflows' })).toBeVisible();
    await page.getByRole('tabpanel', { name: 'Workflows' }).getByTitle('New OWS workflow').click();
    const createDialog = page.getByRole('dialog', { name: 'Create OWS workflow' });
    await createDialog.getByPlaceholder('Workflow name').fill('Desktop OWS flow');
    await createDialog.getByRole('button', { name: 'Create' }).click();

    const editor = page.getByRole('dialog', { name: 'OWS workflow: desktop-ows-flow' });
    await editor
      .getByRole('textbox', { name: 'OWS workflow JSON' })
      .fill(JSON.stringify(WORKFLOW_DOCUMENT));
    await editor.getByRole('tab', { name: 'Bindings' }).click();
    await editor
      .getByRole('textbox', { name: 'OWS bindings JSON' })
      .fill(JSON.stringify(WORKFLOW_BINDINGS));
    await editor.getByRole('button', { name: 'Validate & save' }).click();
    await expect(editor.getByText('Saved as validated OWS artifacts.')).toBeVisible();

    await editor.getByRole('tab', { name: 'Task graph' }).click();
    await expect(editor.getByText('/do/0/initialize/do/0/setContext')).toBeVisible();
    await expect(editor.getByText('/do/0/initialize/do/1/boundedDelay')).toBeVisible();
    await expect(editor.getByText('/do/1/callSavedRequest')).toBeVisible();

    await editor.getByRole('button', { name: 'Run' }).click();
    const runDialog = page.getByRole('dialog', { name: /desktop-ows-flow/ });
    await runDialog.getByRole('button', { name: 'Run OWS workflow' }).click();
    await expect(runDialog.getByText('success', { exact: true }).first()).toBeVisible();
    await expect(runDialog.getByText('/do/1/callSavedRequest')).toBeVisible();
    expect(servers.http.requests().some((request) => request.path === '/json')).toBe(true);
    await runDialog.getByRole('button', { name: 'Close' }).first().click();
  });

  test('rejects every unsupported control and call transport before it can be saved', async ({
    app: page,
  }) => {
    await page.getByRole('tab', { name: 'Collections', exact: true }).click();
    await page.getByRole('button', { name: 'New collection', exact: true }).click();
    await page.keyboard.press('Enter');
    await expect(page.getByText('New Collection', { exact: true }).last()).toBeVisible();
    await page.getByRole('tab', { name: 'Workflows', exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: 'Workflows' })).toBeVisible();
    await page
      .getByRole('tabpanel', { name: 'Workflows' })
      .getByTitle('New OWS workflow')
      .first()
      .click();
    const createDialog = page.getByRole('dialog', { name: 'Create OWS workflow' });
    await createDialog.getByPlaceholder('Workflow name').fill('Unsafe control');
    await createDialog.getByRole('button', { name: 'Create' }).click();

    const editor = page.getByRole('dialog', { name: 'OWS workflow: unsafe-control' });
    const documentInput = editor.getByRole('textbox', { name: 'OWS workflow JSON' });
    const unsupportedControls = ['fork', 'for', 'emit', 'listen', 'raise', 'run', 'switch', 'try'];
    for (const control of unsupportedControls) {
      await documentInput.fill(
        JSON.stringify({
          ...WORKFLOW_DOCUMENT,
          document: { ...WORKFLOW_DOCUMENT.document, name: 'unsafe-control' },
          do: [{ unsafe: { [control]: {} } }],
        })
      );
      await editor.getByRole('button', { name: 'Validate & save' }).click();
      await expect(editor.getByRole('alert')).toContainText(
        `OWS '${control}' tasks are not implemented`
      );
    }

    for (const transport of ['grpc', 'openapi', 'asyncapi', 'mcp', 'a2a']) {
      await documentInput.fill(
        JSON.stringify({
          ...WORKFLOW_DOCUMENT,
          document: { ...WORKFLOW_DOCUMENT.document, name: 'unsafe-control' },
          do: [{ unsafe: { call: transport, with: {} } }],
        })
      );
      await editor.getByRole('button', { name: 'Validate & save' }).click();
      await expect(editor.getByRole('alert')).toContainText(
        'Restura supports only binding-only HTTP calls'
      );
    }
  });
});
