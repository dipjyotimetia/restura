import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  fillFirstMonacoEditor,
  fillMonacoEditor,
  getMonacoEditorValue,
  selectHttpMethod,
  setUrl,
  switchMode,
} from '../../e2e/utils/selectors';
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
      resourceId: 'Workflow%20GET',
    },
  },
};

async function createCollectionAndSavedRequest(
  page: Parameters<typeof setUrl>[0],
  url: string,
  method = 'GET'
): Promise<{ collectionName: string; requestName: string }> {
  await switchMode(page, 'http');
  if (method !== 'GET') await selectHttpMethod(page, method);
  await setUrl(page, url);
  const requestTab = page
    .getByRole('tablist', { name: 'Request tabs' })
    .getByRole('tab', { selected: true });
  await requestTab.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Save to Collection…' }).click();

  const saveDialog = page.getByRole('dialog', { name: 'Save to Collection' });
  const requestName = `Workflow ${method}`;
  const collectionName = `Workflow E2E ${Date.now()} ${method}`;
  await saveDialog.getByPlaceholder('Request name').fill(requestName);
  const newMode = saveDialog.getByRole('button', { name: 'New' });
  if (await newMode.count()) await newMode.click();
  await saveDialog.getByPlaceholder('New collection name').fill(collectionName);
  await saveDialog.getByRole('button', { name: 'Save' }).click();
  return { collectionName, requestName };
}

async function createCollectionAndSavedGraphqlRequest(
  page: Parameters<typeof setUrl>[0],
  url: string,
  query: string,
  suffix: string
): Promise<{ collectionName: string; requestName: string }> {
  await switchMode(page, 'graphql');
  await page.getByRole('textbox', { name: 'GraphQL endpoint URL' }).fill(url);
  await fillFirstMonacoEditor(page, query);
  const requestTab = page
    .getByRole('tablist', { name: 'Request tabs' })
    .getByRole('tab', { selected: true });
  await requestTab.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Save to Collection…' }).click();

  const saveDialog = page.getByRole('dialog', { name: 'Save to Collection' });
  const requestName = `Workflow GraphQL ${suffix}`;
  const collectionName = `Workflow GraphQL E2E ${Date.now()} ${suffix}`;
  await saveDialog.getByPlaceholder('Request name').fill(requestName);
  const newMode = saveDialog.getByRole('button', { name: 'New' });
  if (await newMode.count()) await newMode.click();
  await saveDialog.getByPlaceholder('New collection name').fill(collectionName);
  await saveDialog.getByRole('button', { name: 'Save' }).click();
  return { collectionName, requestName };
}

test.describe('Desktop workflows', () => {
  test('uses Monaco for both advanced artifacts and blocks an invalid draft before it runs', async ({
    app: page,
  }) => {
    await page.getByRole('tab', { name: 'Collections', exact: true }).click();
    await page.getByRole('button', { name: 'New collection', exact: true }).click();
    await page.keyboard.press('Enter');
    await page.getByRole('tab', { name: 'Workflows', exact: true }).click();
    await page
      .getByRole('tabpanel', { name: 'Workflows' })
      .getByTitle('New workflow')
      .first()
      .click();
    const createDialog = page.getByRole('dialog', { name: 'Create workflow' });
    await createDialog.getByPlaceholder('Workflow name').fill('Monaco diagnostics');
    await createDialog.getByRole('button', { name: 'Create' }).click();

    const editor = page.getByRole('dialog', { name: 'Workflow: monaco-diagnostics' });
    await editor.getByRole('tab', { name: 'Workflow JSON' }).click();
    const workflowJsonEditor = editor.getByRole('code').first();
    const bindingsJsonEditor = editor.getByRole('code').last();
    await expect(workflowJsonEditor).toBeVisible();
    await expect(editor.getByRole('region', { name: 'Workflow JSON problems' })).toContainText(
      'Problems: none'
    );
    await editor.getByRole('tab', { name: 'Bindings' }).click();
    await expect(bindingsJsonEditor).toBeVisible();
    await expect(
      editor.getByRole('region', { name: 'Workflow bindings JSON problems' })
    ).toBeVisible();
    await editor.getByRole('tab', { name: 'Workflow JSON' }).click();

    await fillMonacoEditor(
      page,
      workflowJsonEditor,
      JSON.stringify({
        ...WORKFLOW_DOCUMENT,
        document: { ...WORKFLOW_DOCUMENT.document, name: 'monaco-diagnostics' },
        do: [{ unsafe: { fork: { branches: [] } } }],
      })
    );
    await expect(editor.getByRole('region', { name: 'Workflow JSON problems' })).toContainText(
      "OWS 'fork' tasks are not implemented"
    );
    await expect(editor.getByRole('button', { name: 'Save before running' })).toBeDisabled();
    await editor.getByRole('button', { name: 'Close' }).first().click();
    await page.getByRole('button', { name: 'Discard changes' }).click();
  });

  test('adds and executes a saved GraphQL query from the workflow graph', async ({
    app: page,
    servers,
  }) => {
    const { requestName } = await createCollectionAndSavedGraphqlRequest(
      page,
      `${servers.http.url}/graphql`,
      'query Viewer { hello(name: "Workflow") }',
      'Query'
    );
    await page.getByRole('tab', { name: 'Workflows', exact: true }).click();
    const panel = page.getByRole('tabpanel', { name: 'Workflows' });
    await panel.getByTitle('New workflow').last().click();
    const createDialog = page.getByRole('dialog', { name: 'Create workflow' });
    await createDialog.getByPlaceholder('Workflow name').fill('GraphQL query');
    await createDialog.getByRole('button', { name: 'Create' }).click();

    const editor = page.getByRole('dialog', { name: 'Workflow: graphql-query' });
    await editor.getByRole('button', { name: requestName }).click();
    await editor.getByRole('button', { name: 'Validate & save' }).click();
    await editor.getByRole('tab', { name: 'Workflow JSON' }).click();
    await expect(
      getMonacoEditorValue(page, editor.locator('.monaco-editor:visible'))
    ).resolves.toContain('POST');
    await editor.getByRole('tab', { name: 'Bindings' }).click();
    await expect(
      getMonacoEditorValue(page, editor.locator('.monaco-editor:visible'))
    ).resolves.toContain('graphql');

    await editor.getByRole('button', { name: 'Run' }).click();
    const runDialog = page.getByRole('dialog', { name: /graphql-query/ });
    await runDialog.getByRole('button', { name: 'Run workflow' }).click();
    await expect(runDialog.getByText('success', { exact: true }).first()).toBeVisible();
    expect(servers.http.requests().some((request) => request.path === '/graphql')).toBe(true);
    await runDialog.getByRole('button', { name: 'Close' }).first().click();
  });

  test('requires explicit confirmation before a saved GraphQL mutation runs', async ({
    app: page,
    servers,
  }) => {
    const { requestName } = await createCollectionAndSavedGraphqlRequest(
      page,
      `${servers.http.url}/graphql`,
      'mutation Create { createUser(name: "Workflow") { id } }',
      'Mutation'
    );
    await page.getByRole('tab', { name: 'Workflows', exact: true }).click();
    const panel = page.getByRole('tabpanel', { name: 'Workflows' });
    await panel.getByTitle('New workflow').last().click();
    const createDialog = page.getByRole('dialog', { name: 'Create workflow' });
    await createDialog.getByPlaceholder('Workflow name').fill('GraphQL mutation');
    await createDialog.getByRole('button', { name: 'Create' }).click();

    const editor = page.getByRole('dialog', { name: 'Workflow: graphql-mutation' });
    await editor.getByRole('button', { name: requestName }).click();
    await editor.getByRole('button', { name: 'Validate & save' }).click();
    await editor.getByRole('button', { name: 'Run' }).click();
    const runDialog = page.getByRole('dialog', { name: /graphql-mutation/ });
    await runDialog.getByRole('button', { name: 'Run workflow' }).click();
    await expect(runDialog.getByText('This workflow will run GraphQL mutations.')).toBeVisible();
    expect(servers.http.requests().filter((request) => request.path === '/graphql')).toHaveLength(
      0
    );
    await runDialog.getByRole('button', { name: 'Confirm & run' }).click();
    await expect(runDialog.getByText('success', { exact: true }).first()).toBeVisible();
    await runDialog.getByRole('button', { name: 'Close' }).first().click();
  });

  test('persists and reloads the complete workflow artifact triplet through Electron IPC', async ({
    app: page,
  }) => {
    const userDataPath = await page.evaluate(() => window.electron?.app.getPath('userData'));
    if (!userDataPath) throw new Error('Electron user data path is unavailable.');
    const workspaceRoot = join(userDataPath, `ows-e2e-${Date.now()}`);
    await mkdir(workspaceRoot, { recursive: true });
    const workflow = {
      document: { ...WORKFLOW_DOCUMENT.document, name: 'ipc-artifact' },
      do: [{ initialize: { wait: { milliseconds: 0 } } }],
    };
    const bindings = { version: 1 as const, tasks: {} };
    const layout = {
      version: 1 as const,
      nodes: { '/do/0/initialize': { x: 10, y: 20 } },
    };

    try {
      const result = await page.evaluate(
        async ({ directoryPath, workflow, bindings, layout }) => {
          const electron = window.electron;
          if (!electron) throw new Error('Electron bridge is unavailable.');
          const collection = await electron.collections.saveToDirectory(
            { id: 'ows-e2e', name: 'OWS E2E', items: [] },
            directoryPath
          );
          const watched = await electron.collections.watchDirectory(directoryPath);
          const saved = await electron.owsWorkspace.save(directoryPath, 'ipc-artifact', {
            workflow,
            bindings,
            layout,
          });
          const listed = await electron.owsWorkspace.list(directoryPath);
          const loaded = await electron.owsWorkspace.load(directoryPath, 'ipc-artifact');
          return { collection, watched, saved, listed, loaded };
        },
        { directoryPath: workspaceRoot, workflow, bindings, layout }
      );

      expect(result.collection).toEqual({ success: true });
      expect(result.watched.success).toBe(true);
      expect(result.saved).toEqual({ ok: true });
      expect(result.listed).toEqual({ ok: true, workflowIds: ['ipc-artifact'] });
      expect(result.loaded).toMatchObject({
        ok: true,
        artifact: { workflow, bindings, layout },
      });
      await expect(
        Promise.all([
          readFile(join(workspaceRoot, 'workflows/ipc-artifact/workflow.ows.json'), 'utf8'),
          readFile(join(workspaceRoot, 'workflows/ipc-artifact/bindings.restura.json'), 'utf8'),
          readFile(join(workspaceRoot, 'workflows/ipc-artifact/layout.restura.json'), 'utf8'),
        ])
      ).resolves.toHaveLength(3);
    } finally {
      await page.evaluate(async (directoryPath) => {
        const electron = window.electron;
        if (electron) await electron.collections.unwatchDirectory(directoryPath);
      }, workspaceRoot);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('authors and runs every supported workflow control through the native HTTP path', async ({
    app: page,
    servers,
  }) => {
    await createCollectionAndSavedRequest(page, `${servers.http.url}/json`);

    await page.getByRole('tab', { name: 'Workflows', exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: 'Workflows' })).toBeVisible();
    await page
      .getByRole('tabpanel', { name: 'Workflows' })
      .getByTitle('New workflow')
      .last()
      .click();
    const createDialog = page.getByRole('dialog', { name: 'Create workflow' });
    await createDialog.getByPlaceholder('Workflow name').fill('Desktop flow');
    await createDialog.getByRole('button', { name: 'Create' }).click();

    const editor = page.getByRole('dialog', { name: 'Workflow: desktop-flow' });
    const allControlsDocument = {
      document: { ...WORKFLOW_DOCUMENT.document, name: 'desktop-flow' },
      output: { as: { result: '${.recovered}' } },
      do: [
        {
          initialize: {
            do: [
              { setContext: { set: { source: 'desktop-e2e', items: ['first', 'second'] } } },
              { boundedDelay: { wait: { milliseconds: 1 } } },
            ],
          },
        },
        {
          onlyWhenExpected: {
            if: '${.source} == "desktop-e2e"',
            do: [{ guardedDelay: { wait: { milliseconds: 1 } } }],
          },
        },
        {
          onlyWhenUnexpected: {
            if: '${.source} == "not-desktop"',
            do: [{ skippedDelay: { wait: { milliseconds: 1 } } }],
          },
        },
        {
          eachItem: {
            for: { each: 'item', at: 'index', in: '${.items}' },
            do: [{ captureItem: { set: { last: '${.item}' } } }],
          },
        },
        {
          recoverable: {
            try: [
              {
                failingAttempt: {
                  for: { each: 'item', in: '${.missing}' },
                  do: [{ captureMissing: { set: { last: '${.item}' } } }],
                },
              },
            ],
            catch: { as: 'error', do: [{ recovered: { set: { recovered: true } } }] },
          },
        },
        {
          callSavedRequest: {
            call: 'http',
            with: { method: 'GET', endpoint: { uri: 'restura://saved-request' } },
          },
        },
      ],
    };
    await editor.getByRole('tab', { name: 'Bindings' }).click();
    await fillMonacoEditor(
      page,
      editor.locator('.monaco-editor:visible'),
      JSON.stringify({
        version: 1,
        tasks: {
          '/do/5/callSavedRequest': WORKFLOW_BINDINGS.tasks['/do/1/callSavedRequest'],
        },
      })
    );
    await editor.getByRole('tab', { name: 'Workflow JSON' }).click();
    await fillMonacoEditor(
      page,
      editor.locator('.monaco-editor:visible'),
      JSON.stringify(allControlsDocument)
    );
    await editor.getByRole('button', { name: 'Validate & save' }).click();
    await expect(editor.getByText('Saved as a validated workflow.')).toBeVisible();

    await editor.getByRole('tab', { name: 'Graph' }).click();
    await expect(editor.getByText('START')).toBeVisible();
    await expect(editor.getByText('END')).toBeVisible();
    await expect(editor.getByText(/Sequence · 2 blocks/)).toBeVisible();
    await expect(editor.getByText(/GET · Workflow%20GET/)).toBeVisible();

    await editor.getByRole('button', { name: 'Run' }).click();
    const runDialog = page.getByRole('dialog', { name: /desktop-flow/ });
    await runDialog.getByRole('button', { name: 'Run workflow' }).click();
    await expect(runDialog.getByText('success', { exact: true }).first()).toBeVisible();
    await expect(
      runDialog.getByRole('listitem').filter({ hasText: '/do/2/onlyWhenUnexpected' }).first()
    ).toHaveText(/skipped/);
    await expect(runDialog.getByText('/do/4/recoverable/catch/do/0/recovered')).toBeVisible();
    await expect(runDialog.getByText('/do/5/callSavedRequest')).toBeVisible();
    await expect(runDialog.getByText(/"result": true/)).toBeVisible();
    expect(servers.http.requests().some((request) => request.path === '/json')).toBe(true);
    await runDialog.getByRole('button', { name: 'Close' }).first().click();
  });

  test('converts safe graph blocks into an executable workflow and typed request binding', async ({
    app: page,
    servers,
  }) => {
    await createCollectionAndSavedRequest(page, `${servers.http.url}/json`);
    await page.getByRole('tab', { name: 'Workflows', exact: true }).click();
    const workflowPanel = page.getByRole('tabpanel', { name: 'Workflows' });
    await workflowPanel.getByTitle('New workflow').last().click();
    const createDialog = page.getByRole('dialog', { name: 'Create workflow' });
    await createDialog.getByPlaceholder('Workflow name').fill('Graph blocks');
    await createDialog.getByRole('button', { name: 'Create' }).click();

    const editor = page.getByRole('dialog', { name: 'Workflow: graph-blocks' });
    await expect(editor.getByText('START')).toBeVisible();
    await editor.getByRole('button', { name: 'Sequence', exact: true }).click();
    await editor.getByRole('button', { name: 'List' }).click();
    await editor.getByRole('button', { name: 'For each', exact: true }).click();
    await editor.getByRole('button', { name: 'Wait' }).click();
    await editor.getByRole('button', { name: /GET Workflow GET/ }).click();
    await editor.getByRole('button', { name: 'Validate & save' }).click();
    await expect(editor.getByText('Saved as a validated workflow.')).toBeVisible();

    await editor.getByRole('tab', { name: 'Workflow JSON' }).click();
    const workflowJson = await getMonacoEditorValue(page, editor.locator('.monaco-editor:visible'));
    expect(workflowJson).toContain('set-1');
    expect(workflowJson).toContain('sequence-1');
    expect(workflowJson).toContain('each-1');
    expect(workflowJson).toContain('request-1');
    await editor.getByRole('tab', { name: 'Bindings' }).click();
    await expect(
      getMonacoEditorValue(page, editor.locator('.monaco-editor:visible'))
    ).resolves.toContain('Workflow%20GET');

    await editor.getByRole('button', { name: 'Run' }).click();
    const runDialog = page.getByRole('dialog', { name: /graph-blocks/ });
    await runDialog.getByRole('button', { name: 'Run workflow' }).click();
    await expect(runDialog.getByText('success', { exact: true }).first()).toBeVisible();
    expect(servers.http.requests().some((request) => request.path === '/json')).toBe(true);
    await runDialog.getByRole('button', { name: 'Close' }).first().click();
  });

  test('runs every supported bound HTTP method through the Electron workflow executor', async ({
    app: page,
    servers,
  }) => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      const { requestName } = await createCollectionAndSavedRequest(
        page,
        `${servers.http.url}/echo`,
        method
      );
      await page.getByRole('tab', { name: 'Workflows', exact: true }).click();
      const workflowPanel = page.getByRole('tabpanel', { name: 'Workflows' });
      await workflowPanel.getByTitle('New workflow').last().click();
      const createDialog = page.getByRole('dialog', { name: 'Create workflow' });
      await createDialog.getByPlaceholder('Workflow name').fill(`Method ${method}`);
      await createDialog.getByRole('button', { name: 'Create' }).click();

      const workflowName = `method-${method.toLowerCase()}`;
      const editor = page.getByRole('dialog', { name: `Workflow: ${workflowName}` });
      await editor.getByRole('tab', { name: 'Workflow JSON' }).click();
      await fillMonacoEditor(
        page,
        editor.locator('.monaco-editor:visible'),
        JSON.stringify({
          document: { ...WORKFLOW_DOCUMENT.document, name: workflowName },
          do: [
            {
              invoke: {
                call: 'http',
                with: { method, endpoint: { uri: 'restura://saved-request' } },
              },
            },
          ],
        })
      );
      await editor.getByRole('tab', { name: 'Bindings' }).click();
      await fillMonacoEditor(
        page,
        editor.locator('.monaco-editor:visible'),
        JSON.stringify({
          version: 1,
          tasks: {
            '/do/0/invoke': {
              kind: 'saved-request',
              call: 'http',
              resourceId: encodeURIComponent(requestName),
            },
          },
        })
      );
      await editor.getByRole('button', { name: 'Validate & save' }).click();
      await editor.getByRole('button', { name: 'Run' }).click();
      const runDialog = page.getByRole('dialog', { name: workflowName });
      await runDialog.getByRole('button', { name: 'Run workflow' }).click();
      await expect(runDialog.getByText('success', { exact: true }).first()).toBeVisible();
      await expect
        .poll(() =>
          servers.http
            .requests()
            .some((request) => request.path === '/echo' && request.method === method)
        )
        .toBe(true);
      await runDialog.getByRole('button', { name: 'Close' }).first().click();
    }
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
      .getByTitle('New workflow')
      .first()
      .click();
    const createDialog = page.getByRole('dialog', { name: 'Create workflow' });
    await createDialog.getByPlaceholder('Workflow name').fill('Unsafe control');
    await createDialog.getByRole('button', { name: 'Create' }).click();

    const editor = page.getByRole('dialog', { name: 'Workflow: unsafe-control' });
    await editor.getByRole('tab', { name: 'Workflow JSON' }).click();
    const unsupportedControls = ['fork', 'emit', 'listen', 'raise', 'run', 'switch'];
    for (const control of unsupportedControls) {
      await fillMonacoEditor(
        page,
        editor.locator('.monaco-editor:visible'),
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
      await fillMonacoEditor(
        page,
        editor.locator('.monaco-editor:visible'),
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

    for (const invalidDocument of [
      { ...WORKFLOW_DOCUMENT, document: { ...WORKFLOW_DOCUMENT.document, dsl: 'bogus' } },
      { ...WORKFLOW_DOCUMENT, do: [] },
      { ...WORKFLOW_DOCUMENT, do: [{ unsafe: { wait: {} } }] },
      { ...WORKFLOW_DOCUMENT, do: [{ unsafe: { for: { each: 'item', in: 'items' }, do: [] } }] },
      { ...WORKFLOW_DOCUMENT, do: [{ unsafe: { try: [], catch: { retry: { count: 1 } } } }] },
    ]) {
      await fillMonacoEditor(
        page,
        editor.locator('.monaco-editor:visible'),
        JSON.stringify(invalidDocument)
      );
      await editor.getByRole('button', { name: 'Validate & save' }).click();
      await expect(editor.getByRole('alert')).toBeVisible();
    }
    await editor.getByRole('button', { name: 'Close' }).first().click();
    await page.getByRole('button', { name: 'Discard changes' }).click();
  });

  test('enforces workflow and task timeouts and lets Stop cancel before a later bound call', async ({
    app: page,
    servers,
  }) => {
    await createCollectionAndSavedRequest(page, `${servers.http.url}/slow?ms=1500`);
    await page.getByRole('tab', { name: 'Workflows', exact: true }).click();
    const workflowPanel = page.getByRole('tabpanel', { name: 'Workflows' });
    await workflowPanel.getByTitle('New workflow').last().click();
    const createDialog = page.getByRole('dialog', { name: 'Create workflow' });
    await createDialog.getByPlaceholder('Workflow name').fill('Cancellation boundary');
    await createDialog.getByRole('button', { name: 'Create' }).click();

    const editor = page.getByRole('dialog', { name: 'Workflow: cancellation-boundary' });
    await editor.getByRole('tab', { name: 'Workflow JSON' }).click();
    const boundCall = {
      callSavedRequest: {
        call: 'http',
        with: { method: 'GET', endpoint: { uri: 'restura://saved-request' } },
      },
    };
    const bindings = {
      version: 1,
      tasks: {
        '/do/1/callSavedRequest': {
          kind: 'saved-request',
          call: 'http',
          resourceId: 'Workflow%20GET',
        },
      },
    };
    await editor.getByRole('tab', { name: 'Bindings' }).click();
    await fillMonacoEditor(
      page,
      editor.locator('.monaco-editor:visible'),
      JSON.stringify(bindings)
    );
    await editor.getByRole('tab', { name: 'Workflow JSON' }).click();

    // Both timeout levels must terminate before the later HTTP task is reached.
    let hasUnsavedChange = true;
    for (const timeoutDocument of [
      {
        document: { ...WORKFLOW_DOCUMENT.document, name: 'cancellation-boundary' },
        timeout: { after: { milliseconds: 1 } },
        do: [{ pause: { wait: { milliseconds: 50 } } }, boundCall],
      },
      {
        document: { ...WORKFLOW_DOCUMENT.document, name: 'cancellation-boundary' },
        do: [
          { pause: { wait: { milliseconds: 50 }, timeout: { after: { milliseconds: 1 } } } },
          boundCall,
        ],
      },
    ]) {
      await fillMonacoEditor(
        page,
        editor.locator('.monaco-editor:visible'),
        JSON.stringify(timeoutDocument)
      );
      if (hasUnsavedChange) {
        await expect(editor.getByRole('button', { name: 'Save before running' })).toBeDisabled();
        hasUnsavedChange = false;
      }
      await editor.getByRole('button', { name: 'Validate & save' }).click();
      await editor.getByRole('button', { name: 'Run' }).click();
      const runDialog = page.getByRole('dialog', { name: /cancellation-boundary/ });
      await runDialog.getByRole('button', { name: 'Run workflow' }).click();
      await expect(runDialog.getByText('failed', { exact: true }).first()).toBeVisible();
      expect(servers.http.requests().filter((request) => request.path === '/slow')).toHaveLength(0);
      await runDialog.getByRole('button', { name: 'Close' }).first().click();
      await workflowPanel
        .getByRole('button', { name: 'Edit workflow cancellation-boundary' })
        .click();
      await editor.getByRole('tab', { name: 'Workflow JSON' }).click();
    }

    // Closing/Stop must abort a wait and prevent the following bound call.
    await fillMonacoEditor(
      page,
      editor.locator('.monaco-editor:visible'),
      JSON.stringify({
        document: { ...WORKFLOW_DOCUMENT.document, name: 'cancellation-boundary' },
        do: [{ pause: { wait: { milliseconds: 500 } } }, boundCall],
      })
    );
    await editor.getByRole('button', { name: 'Validate & save' }).click();
    await editor.getByRole('button', { name: 'Run' }).click();
    const runDialog = page.getByRole('dialog', { name: /cancellation-boundary/ });
    await runDialog.getByRole('button', { name: 'Run workflow' }).click();
    await expect(runDialog.getByRole('button', { name: 'Stop' })).toBeVisible();
    await runDialog.getByRole('button', { name: 'Stop' }).click();
    await expect(runDialog.getByText('stopped', { exact: true }).first()).toBeVisible();
    expect(servers.http.requests().filter((request) => request.path === '/slow')).toHaveLength(0);
  });
});
