import { test, expect } from '../fixtures/tls';
import type { Page } from '@playwright/test';
import { switchMode, setUrl, sendButton } from '../../e2e/utils/selectors';

/**
 * Desktop-only TLS transport: custom CA bundle + mTLS client certificate. These
 * have NO web e2e backstop — a browser inherits the system trust store and
 * can't present a per-request client cert. The upstream leaf is signed by a
 * PRIVATE CA the OS doesn't trust and `verifySsl` defaults on, so a 200 proves
 * the imported CA (and, for mTLS, the client cert) was applied to the real
 * handshake. If the desktop transport dropped either, the handshake would fail
 * and there'd be no 200 (fail-when-broken).
 */

async function openCertificates(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await page.getByRole('button', { name: 'Open settings' }).click();
  const drawer = page.getByRole('dialog', { name: 'Settings' });
  await drawer.getByRole('button', { name: 'Certificates', exact: true }).click();
  return drawer;
}

/** Paste (or clear, with '') the custom CA PEM. Commits on change. */
async function setCustomCa(page: Page, pem: string): Promise<void> {
  const drawer = await openCertificates(page);
  await drawer.locator('#ca-pem-paste').fill(pem);
  await page.getByRole('button', { name: 'Close settings' }).click();
}

test.describe('Desktop TLS — custom CA + mTLS', () => {
  test('a CA-signed upstream verifies only after the custom CA is imported', async ({
    app: page,
    tls,
  }) => {
    try {
      await switchMode(page, 'http');
      await setUrl(page, `${tls.https.url}/json`);

      // Negative leg (proves the CA is necessary): with no custom CA and
      // verifySsl on, the private-CA leaf fails verification at the handshake —
      // the request never reaches the server, so the recorder stays empty.
      await sendButton(page).click();
      await expect(page.getByText(/Request failed/i).first()).toBeVisible();
      expect(tls.https.requestCount()).toBe(0);

      // Positive leg: import the CA and retry — now the handshake completes.
      await setCustomCa(page, tls.certs.caPem.toString());
      await sendButton(page).click();
      await expect(page.getByText('200', { exact: true }).first()).toBeVisible();
      await expect(page.getByText(/"hello"/).first()).toBeVisible();
      expect(tls.https.requestCount()).toBeGreaterThanOrEqual(1);
    } finally {
      // Custom CA replaces the system trust store globally and persists in the
      // shared window — clear it so it can't break later specs.
      await setCustomCa(page, '');
    }
  });

  test('an mTLS upstream accepts a client certificate attached in settings', async ({
    app: page,
    tls,
  }) => {
    try {
      // Trust the server's private-CA leaf AND present a client cert (PEM).
      const drawer = await openCertificates(page);
      await drawer.locator('#ca-pem-paste').fill(tls.certs.caPem.toString());
      await drawer.getByRole('button', { name: 'PEM', exact: true }).click();
      await drawer
        .locator('input[type="file"][accept=".pem,.crt"]')
        .setInputFiles(tls.certs.clientCertPath);
      await drawer
        .locator('input[type="file"][accept=".pem,.key"]')
        .setInputFiles(tls.certs.clientKeyPath);
      await page.getByRole('button', { name: 'Close settings' }).click();

      await switchMode(page, 'http');
      await setUrl(page, `${tls.mtls.url}/mtls/whoami`);
      await sendButton(page).click();

      // The server demands a client cert (requestCert + rejectUnauthorized): a
      // 200 with the client subject proves the cert was presented at the wire.
      // Without it the TLS handshake is rejected and there is no 200.
      await expect(page.getByText('200', { exact: true }).first()).toBeVisible();
      await expect(page.getByText(/restura-client/).first()).toBeVisible();
    } finally {
      const drawer = await openCertificates(page);
      await drawer.getByRole('button', { name: 'Clear Certificate' }).click();
      await drawer.locator('#ca-pem-paste').fill('');
      await page.getByRole('button', { name: 'Close settings' }).click();
    }
  });

  test('a TLSv1.3 minimum is enforced against a TLSv1.2-capped server', async ({
    app: page,
    tls,
  }) => {
    await switchMode(page, 'http');
    await setUrl(page, `${tls.tls12.url}/json`);

    // Per-request Settings: turn OFF cert verification (the leaf is private-CA
    // signed) to isolate the protocol-version check, and open TLS advanced.
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    // Per-request settings are a read-only summary until override is enabled.
    const override = page
      .getByRole('switch', { name: 'Toggle settings override' })
      .filter({ visible: true })
      .first();
    if ((await override.getAttribute('aria-checked')) !== 'true') await override.click();
    // Skip cert trust (the leaf is private-CA signed) to isolate the
    // protocol-version check, then reveal the TLS advanced controls.
    const verify = page
      .getByRole('switch', { name: 'Toggle SSL verification' })
      .filter({ visible: true })
      .first();
    if ((await verify.getAttribute('aria-checked')) === 'true') await verify.click();
    await page
      .getByRole('button', { name: /TLS advanced/i })
      .filter({ visible: true })
      .first()
      .click();

    const selectMinTls = async (optionName: string): Promise<void> => {
      await page.locator('#minTlsVersion').filter({ visible: true }).first().click();
      await page.getByRole('option', { name: optionName, exact: true }).click();
    };

    // Floor above the server's cap → no shared protocol → handshake rejected,
    // the request never reaches the server (fail-when-broken: an ignored floor
    // would negotiate TLSv1.2 and succeed).
    await selectMinTls('TLSv1.3');
    await sendButton(page).click();
    await expect(page.getByText(/Request failed/i).first()).toBeVisible();
    expect(tls.tls12.requestCount()).toBe(0);

    // Control: lower the floor to TLSv1.2 — now the handshake completes.
    await selectMinTls('TLSv1.2');
    await sendButton(page).click();
    await expect(page.getByText('200', { exact: true }).first()).toBeVisible();
    expect(tls.tls12.requestCount()).toBeGreaterThanOrEqual(1);
  });

  test('a cipher-suite mismatch is rejected at the handshake', async ({ app: page, tls }) => {
    await page.keyboard.press('Escape'); // clear any open dropdown from a prior test
    await switchMode(page, 'http');
    await setUrl(page, `${tls.cipherPinned.url}/json`);

    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    const override = page
      .getByRole('switch', { name: 'Toggle settings override' })
      .filter({ visible: true })
      .first();
    if ((await override.getAttribute('aria-checked')) !== 'true') await override.click();
    const verify = page
      .getByRole('switch', { name: 'Toggle SSL verification' })
      .filter({ visible: true })
      .first();
    if ((await verify.getAttribute('aria-checked')) === 'true') await verify.click();
    // Open TLS advanced idempotently — toggling a section another test left open
    // would close it and hide #cipherSuites.
    const tlsAdvanced = page
      .getByRole('button', { name: /TLS advanced/i })
      .filter({ visible: true })
      .first();
    if ((await tlsAdvanced.getAttribute('aria-expanded')) !== 'true') await tlsAdvanced.click();
    const cipherInput = page.locator('#cipherSuites').filter({ visible: true }).first();

    // The server offers only `pinnedCipher` (at TLSv1.2). Requesting a different
    // suite leaves no shared cipher → the handshake is rejected and the request
    // never reaches the server (fail-when-broken: an ignored cipherSuites would
    // negotiate the server's default and succeed).
    await cipherInput.fill('ECDHE-RSA-AES256-GCM-SHA384');
    await sendButton(page).click();
    await expect(page.getByText(/Request failed/i).first()).toBeVisible();
    expect(tls.cipherPinned.requestCount()).toBe(0);

    // Control: request the suite the server actually offers — handshake completes.
    await cipherInput.fill(tls.pinnedCipher);
    await sendButton(page).click();
    await expect(page.getByText('200', { exact: true }).first()).toBeVisible();
    expect(tls.cipherPinned.requestCount()).toBeGreaterThanOrEqual(1);
  });
});
