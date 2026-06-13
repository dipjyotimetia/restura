import type { Page, Locator } from '@playwright/test';

export const modes = {
  http: 'HTTP request',
  graphql: 'GraphQL request',
  grpc: 'gRPC request',
  ws: 'WS',
  socketio: 'Socket.IO',
  sse: 'SSE stream',
  mcp: 'MCP request',
  // Desktop-only: only present in the menu when isElectron() is true (e.g. the
  // mocked-Electron MQTT e2e). On the web build the item is gated off.
  mqtt: 'MQTT client',
} as const;

export type Mode = keyof typeof modes;

export async function switchMode(page: Page, mode: Mode): Promise<void> {
  await page.getByRole('button', { name: 'new request', exact: true }).click();
  // Each item renders a decorative <ProtoChip> whose label (e.g. "GQL", "WS")
  // prefixes the menuitem's accessible name — "GQL GraphQL request". Match on
  // the (unique) text label as a substring rather than an exact string.
  await page.getByRole('menuitem', { name: modes[mode] }).click();
}

export function sendButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Send request', exact: true });
}

export function methodSelect(page: Page): Locator {
  return page.getByRole('button', { name: /HTTP method:/ });
}

export function paramsTab(page: Page): Locator {
  return page.getByRole('tab', { name: 'Params', exact: true });
}

export function headersTab(page: Page): Locator {
  return page.getByRole('tab', { name: 'Headers', exact: true });
}

export function bodyTab(page: Page): Locator {
  return page.getByRole('tab', { name: 'Body', exact: true });
}

export function settingsTab(page: Page): Locator {
  return page.getByRole('tab', { name: 'Settings', exact: true });
}

export async function setUrl(page: Page, url: string): Promise<void> {
  const field = page.getByRole('textbox', { name: 'Request URL' });
  await field.click();
  await field.fill(url);
}

export async function selectHttpMethod(page: Page, method: string): Promise<void> {
  await methodSelect(page).click();
  await page
    .getByRole('menuitem', { name: method === 'DELETE' ? 'DEL' : method, exact: true })
    .click();
}

export async function selectBodyType(page: Page, type: string): Promise<void> {
  await page.getByRole('radio', { name: type, exact: true }).click();
}

export async function fillFirstMonacoEditor(page: Page, text: string): Promise<void> {
  const editor = page.locator('.monaco-editor').first();
  await editor.waitFor({ state: 'visible' });
  const changedViaReact = await editor.evaluate((node, value) => {
    const reactFiberKey = Object.keys(node.parentElement ?? node).find((key) =>
      key.startsWith('__reactFiber$')
    );
    let fiber = reactFiberKey
      ? (node.parentElement ?? node)[reactFiberKey as keyof Element]
      : undefined;

    while (fiber) {
      const props = (fiber as { memoizedProps?: { onChange?: unknown } }).memoizedProps;
      if (typeof props?.onChange === 'function') {
        (props.onChange as (value: string) => void)(value);
        return true;
      }
      fiber = (fiber as { return?: unknown }).return;
    }

    return false;
  }, text);
  if (changedViaReact) return;

  const uri = await editor.evaluate((node) => {
    const editorNode = node.closest('.monaco-editor') ?? node;
    return editorNode.getAttribute('data-uri');
  });
  const updated = await page.evaluate(
    ({ value, uri }) => {
      const monaco = (
        window as unknown as {
          monaco?: {
            editor?: {
              getModels?: () => Array<{
                uri?: { toString: () => string };
                getLanguageId?: () => string;
                setValue: (value: string) => void;
              }>;
            };
          };
        }
      ).monaco;
      const models = monaco?.editor?.getModels?.() ?? [];
      const model =
        (uri ? models.find((m) => m.uri?.toString() === uri) : undefined) ??
        models.find((m) => m.uri?.toString().includes('graphql-query')) ??
        models.find((m) => m.getLanguageId?.() !== 'json') ??
        models.at(-1);
      if (!model) return false;
      model.setValue(value);
      return true;
    },
    { value: text, uri }
  );
  if (!updated) {
    await page
      .locator('.monaco-editor .view-lines')
      .first()
      .click({ force: true, position: { x: 10, y: 10 } });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.insertText(text);
  }
}
