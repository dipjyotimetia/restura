import type { Page, Locator } from '@playwright/test';

export const modes = {
  http: 'Switch to HTTP mode',
  graphql: 'Switch to GraphQL mode',
  grpc: 'Switch to gRPC mode',
  ws: 'Switch to WS mode',
  socketio: 'Switch to Socket.IO mode',
  sse: 'Switch to SSE mode',
  mcp: 'Switch to MCP mode',
} as const;

export type Mode = keyof typeof modes;

export async function switchMode(page: Page, mode: Mode): Promise<void> {
  await page.getByRole('button', { name: modes[mode] }).first().click();
}

export function sendButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Send request', exact: true });
}

export function methodSelect(page: Page): Locator {
  return page.getByRole('combobox', { name: 'HTTP Method' });
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

export async function setUrl(page: Page, url: string): Promise<void> {
  const field = page.getByRole('textbox', { name: 'Request URL' });
  await field.click();
  await field.fill(url);
}

export async function selectHttpMethod(page: Page, method: string): Promise<void> {
  await methodSelect(page).click();
  await page.getByRole('option', { name: method, exact: true }).click();
}
