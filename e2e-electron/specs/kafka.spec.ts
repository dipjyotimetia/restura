import { dockerAvailable, expect, test } from '../fixtures/brokers';

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
    // Invalid UTF-8 bytes exercise the Base64 producer/consumer contract. The
    // received row must display the same canonical Base64 rather than a lossy
    // replacement-character string.
    const value = '/4AB';
    const headerName = `x-restura-e2e-${stamp}`;
    const headerValue = `binary-${stamp}`;

    // Enter Kafka mode (desktop-only; not in the shared switchMode map).
    await page.getByRole('button', { name: 'new request', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Kafka client' }).click();

    // Configure a transactional producer before connecting.
    await page.getByRole('tab', { name: 'Produce' }).click();
    const producerSetup = page.getByRole('tabpanel');
    await producerSetup.getByText('Batches, streams, and transactions').click();
    await producerSetup.getByPlaceholder('Stable ID; reconnect to apply').fill(`txn-${stamp}`);

    // Connect — defaults are localhost:9092 + PLAINTEXT.
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByRole('button', { name: /Disconnect/ })).toBeVisible({ timeout: 20_000 });

    // Admin: create the topic deterministically (don't rely on auto-create).
    await page.getByRole('tab', { name: /Admin/ }).click();
    const admin = page.getByRole('tabpanel');
    await admin.getByPlaceholder('topic-name').fill(topic);
    await admin.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(admin.getByText(topic).first()).toBeVisible({ timeout: 15_000 });
    await admin.getByText('Advanced administration').scrollIntoViewIfNeeded();
    await admin.getByText('Cluster metadata').click();
    await admin.getByRole('button', { name: 'Describe cluster' }).click();
    await expect(admin.getByText(/controllerId/)).toBeVisible();

    // Consume from EARLIEST so delivery doesn't depend on subscribe/produce order.
    await page.getByRole('tab', { name: 'Consume' }).click();
    const consume = page.getByRole('tabpanel');
    await consume.getByPlaceholder('topic-name').fill(topic);
    await consume.getByRole('button', { name: 'Add', exact: true }).click();
    // Start mode → earliest (the "Consume start mode" Segmented sets fromBeginning).
    await consume.getByRole('radio', { name: 'earliest', exact: true }).click();
    await consume.getByText('Delivery and group options').click();
    await consume.locator('select').first().selectOption('manual');
    await consume.locator('select').nth(1).selectOption('read-committed');
    await consume.getByRole('button', { name: 'Subscribe', exact: true }).click();
    await expect(page.getByText('Subscribed').first()).toBeVisible({ timeout: 20_000 });
    await consume.getByRole('button', { name: 'Pause consumer' }).click();
    await expect(consume.getByRole('button', { name: 'Resume consumer' })).toBeVisible();
    await consume.getByRole('button', { name: 'Resume consumer' }).click();

    // Produce arbitrary bytes to an explicit partition with a header.
    await page.getByRole('tab', { name: 'Produce' }).click();
    const produce = page.getByRole('tabpanel');
    await produce.getByPlaceholder('my-topic').fill(topic);
    await produce.getByLabel('Kafka partition').fill('0');
    await produce.getByRole('button', { name: 'Add header' }).click();
    await produce.getByRole('textbox', { name: 'Kafka header key' }).fill(headerName);
    await produce.getByRole('textbox', { name: 'Kafka header value' }).fill(headerValue);
    await produce.getByRole('combobox', { name: 'Value payload format' }).click();
    await page.getByRole('option', { name: 'Base64 bytes', exact: true }).click();
    await produce.getByLabel('Kafka message value').fill(value);
    await produce.getByRole('button', { name: 'Publish' }).click();

    // Messages: the produce logs a 'sent' row and the consumer reads the same
    // record back as 'received' — the unique value appears exactly twice. A
    // broken consume path leaves only the 'sent' row (fail-when-broken).
    await page.getByRole('tab', { name: /Messages/ }).click();
    await expect(page.getByText(value).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(value)).toHaveCount(2, { timeout: 20_000 });
    await page.getByText(value).last().click();
    await expect(page.getByText(headerName)).toBeVisible();
    await expect(page.getByText(headerValue)).toBeVisible();
    await page.getByRole('button', { name: 'Commit this message' }).click();
    await expect(page.getByRole('button', { name: 'Offset committed' })).toBeVisible();

    // A transaction session uses the same batch record model and stays invisible
    // to the read-committed consumer until committed.
    const transactionalValue = `transactional-${stamp}`;
    await page.getByRole('tab', { name: 'Produce' }).click();
    const batchEditor = produce.getByLabel('Kafka typed record batch');
    if (!(await batchEditor.isVisible())) {
      await produce.getByText('Batches, streams, and transactions').click();
    }
    await batchEditor.fill(
      JSON.stringify([
        { topic, value: { encoding: 'utf8', data: transactionalValue }, partition: 0 },
      ])
    );
    await produce.getByRole('button', { name: 'Begin transaction' }).click();
    await produce.getByRole('button', { name: 'Publish batch' }).click();
    await produce.getByRole('button', { name: 'Commit', exact: true }).click();
    await page.getByRole('tab', { name: /Messages/ }).click();
    await expect(page.getByText(transactionalValue)).toBeVisible({ timeout: 20_000 });

    // Tombstones are a true Kafka null, not an empty string.
    await page.getByRole('tab', { name: 'Produce' }).click();
    await produce.getByRole('switch', { name: 'Tombstone (Kafka null value)' }).click();
    await expect(
      produce.getByRole('switch', { name: 'Tombstone (Kafka null value)' })
    ).toBeChecked();
    await produce.getByRole('button', { name: 'Publish' }).click();
    await page.getByRole('tab', { name: /Messages/ }).click();
    await expect(page.getByText('<tombstone>').first()).toBeVisible({ timeout: 20_000 });

    await page
      .getByRole('button', { name: /Disconnect/ })
      .first()
      .click()
      .catch(() => {});
  });
});
