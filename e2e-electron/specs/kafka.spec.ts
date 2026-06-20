import { test, expect, dockerAvailable } from '../fixtures/brokers';

// Requires the Dockerised Redpanda broker; skip (don't fail) when Docker is absent.
const describeOrSkip = dockerAvailable() ? test.describe : test.describe.skip;

/**
 * Desktop Kafka round-trip against a REAL broker (Redpanda via Docker) →
 * renderer → IPC → kafka-handler (@platformatic/kafka) → broker → back. No
 * in-process mock exists for Kafka; this is the only end-to-end coverage of the
 * native broker transport. The client defaults to localhost:9092 / PLAINTEXT,
 * matching the Dockerised Redpanda listener.
 *
 * A unique topic + value per run keeps it isolated and re-runnable; consuming
 * from EARLIEST avoids the consumer-group-assignment race that a "latest"
 * subscribe would have against a live broker.
 */
describeOrSkip('Desktop Kafka (live Redpanda broker)', () => {
  test('connect → create topic → subscribe → produce round-trips via the broker', async ({
    app: page,
    brokers,
  }) => {
    expect(brokers.kafka).toBe('localhost:9092');
    const stamp = await page.evaluate(() => String(Date.now()));
    const topic = `restura-e2e-${stamp}`;
    const value = `kafka-live-${stamp}`;

    // Enter Kafka mode (desktop-only; not in the shared switchMode map).
    await page.getByRole('button', { name: 'new request', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Kafka consumer' }).click();

    // Connect — defaults are localhost:9092 + PLAINTEXT.
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByRole('button', { name: /Disconnect/ })).toBeVisible({ timeout: 20_000 });

    // Admin: create the topic deterministically (don't rely on auto-create).
    await page.getByRole('tab', { name: /Admin/ }).click();
    const admin = page.getByRole('tabpanel');
    await admin.getByPlaceholder('topic-name').fill(topic);
    await admin.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(admin.getByText(topic).first()).toBeVisible({ timeout: 15_000 });

    // Consume from EARLIEST so delivery doesn't depend on subscribe/produce order.
    await page.getByRole('tab', { name: 'Consume' }).click();
    const consume = page.getByRole('tabpanel');
    await consume.getByPlaceholder('topic-name').fill(topic);
    await consume.getByRole('button', { name: 'Add', exact: true }).click();
    // Start mode → earliest (the "Consume start mode" Segmented sets fromBeginning).
    await consume.getByRole('radio', { name: 'earliest', exact: true }).click();
    await consume.getByRole('button', { name: 'Subscribe', exact: true }).click();
    await expect(page.getByText('Subscribed').first()).toBeVisible({ timeout: 20_000 });

    // Produce the unique value.
    await page.getByRole('tab', { name: 'Produce' }).click();
    const produce = page.getByRole('tabpanel');
    await produce.getByPlaceholder('my-topic').fill(topic);
    await produce.locator('textarea').fill(value);
    await produce.getByRole('button', { name: 'Publish' }).click();

    // Messages: the produce logs a 'sent' row and the consumer reads the same
    // record back as 'received' — the unique value appears exactly twice. A
    // broken consume path leaves only the 'sent' row (fail-when-broken).
    await page.getByRole('tab', { name: /Messages/ }).click();
    await expect(page.getByText(value).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(value)).toHaveCount(2, { timeout: 20_000 });

    await page
      .getByRole('button', { name: /Disconnect/ })
      .first()
      .click()
      .catch(() => {});
  });
});
