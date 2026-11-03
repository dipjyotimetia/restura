import { expect, type Page } from '@playwright/test';

/**
 * Point the active gRPC tab at a target deterministically.
 *
 * Order matters: a new tab's default URL is the public echo server, and a URL
 * change starts auto-discovery, which can select a service / method and turn
 * the Service / Method text fields into pickers. So the URL is set first, the
 * optional `.proto` is uploaded next (it selects its first service + method),
 * and service / method are then set through whichever control is showing.
 */
export async function setGrpcTarget(
  page: Page,
  target: {
    url: string;
    service: string;
    method: string;
    proto?: { name: string; text: string };
  }
): Promise<void> {
  await page.getByRole('textbox', { name: 'gRPC server URL' }).fill(target.url);
  // Let auto-discovery for this URL settle (services listed → pickers, or a
  // reflection error) so it can't overwrite the fields after we set them.
  await page
    .getByRole('combobox')
    .first()
    .or(page.getByText(/Reflection failed/).first())
    .waitFor({ state: 'visible', timeout: 8_000 })
    .catch(() => {});
  if (target.proto) {
    await page.getByLabel('Upload .proto file').setInputFiles({
      name: target.proto.name,
      mimeType: 'text/plain',
      buffer: Buffer.from(target.proto.text),
    });
    await expect(page.getByRole('button', { name: target.proto.name }).first()).toBeVisible();
  }
  await chooseOrFill(page, 'service', target.service);
  await chooseOrFill(page, 'method', target.method);
}

const PLACEHOLDER = { service: /Service \(e\.g\./i, method: /Method \(e\.g\./i } as const;

/** Set service / method through the text field or, after discovery, the picker — verified. */
async function chooseOrFill(page: Page, which: 'service' | 'method', value: string): Promise<void> {
  const field = page.getByPlaceholder(PLACEHOLDER[which]);
  // Either field may be a picker independently; the method picker always
  // follows the service control, so it is the last combobox, service the first.
  const pickers = page.getByRole('combobox');
  const picker = which === 'service' ? pickers.first() : pickers.last();
  await expect(async () => {
    if (await field.isVisible()) {
      await field.fill(value, { timeout: 2_000 });
      await expect(field).toHaveValue(value, { timeout: 1_000 });
    } else {
      if (((await picker.textContent()) ?? '').trim() !== value) {
        await picker.click({ timeout: 2_000 });
        await page.getByRole('option', { name: value, exact: true }).click({ timeout: 2_000 });
      }
      await expect(picker).toHaveText(value, { timeout: 1_000 });
    }
  }).toPass({ timeout: 20_000 });
}
