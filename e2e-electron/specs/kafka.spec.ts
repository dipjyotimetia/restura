import { Admin, Producer } from '@platformatic/kafka';
import { fillMonacoEditor } from '../../e2e/utils/selectors';
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
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
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
    const producerSetup = page.getByRole('tabpanel', { name: 'Produce' });
    await producerSetup.getByRole('tab', { name: 'Transaction' }).click();
    await producerSetup.getByPlaceholder('Stable ID; reconnect to apply').fill(`txn-${stamp}`);

    // Connect — defaults are localhost:9092 + PLAINTEXT.
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByRole('button', { name: /Disconnect/ })).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole('status', { name: 'Kafka connection status: Connected' })
    ).toBeVisible();

    // Admin: create the topic deterministically (don't rely on auto-create).
    await page.getByRole('tab', { name: /Admin/ }).click();
    const admin = page.getByRole('tabpanel', { name: 'Admin' });
    await admin.getByLabel('Topic name').fill(topic);
    await admin.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(admin.getByText(topic).first()).toBeVisible({ timeout: 15_000 });
    await admin.getByRole('searchbox', { name: 'Filter topics' }).fill(topic);
    await expect(admin.getByText(/1 of \d+ topics/)).toBeVisible();
    await admin.getByRole('searchbox', { name: 'Filter topics' }).clear();
    await admin.getByText('Advanced administration').scrollIntoViewIfNeeded();
    await admin.getByText('Cluster metadata').click();
    await admin.getByRole('button', { name: 'Describe cluster' }).click();
    const clusterResultEditor = admin.getByRole('textbox', {
      name: 'Describe cluster result JSON',
    });
    await expect(clusterResultEditor).toBeVisible();
    await expect(admin.getByRole('status').locator('.monaco-editor .view-lines')).toContainText(
      'controllerId'
    );

    // Consume from EARLIEST so delivery doesn't depend on subscribe/produce order.
    await page.getByRole('tab', { name: 'Consume' }).click();
    const consume = page.getByRole('tabpanel', { name: 'Consume' });
    // New tabs default to read-only Browse; this flow exercises group commits.
    await consume.getByRole('radio', { name: 'Consumer group' }).click();
    await consume.getByPlaceholder('topic-name').fill(topic);
    await consume.getByRole('button', { name: 'Add', exact: true }).click();
    await consume.getByLabel('Consume start position').selectOption('earliest');
    await consume.getByLabel('Commit policy').selectOption('manual');
    await consume.getByLabel('Isolation').selectOption('read-committed');
    await consume.getByRole('button', { name: 'Subscribe', exact: true }).click();
    await expect(consume.getByText('Subscription: Subscribed')).toBeVisible({ timeout: 20_000 });
    await consume.getByRole('button', { name: 'Pause consumer' }).click();
    await expect(consume.getByRole('button', { name: 'Resume consumer' })).toBeVisible();
    await consume.getByRole('button', { name: 'Resume consumer' }).click();
    await expect(consume.getByRole('button', { name: 'Pause consumer' })).toBeVisible();

    // Produce arbitrary bytes to an explicit partition with a header.
    await page.getByRole('tab', { name: 'Produce' }).click();
    const produce = page.getByRole('tabpanel', { name: 'Produce' });
    await produce.getByRole('tab', { name: 'Single record' }).click();
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
    await expect(page.getByText('Activity').first()).toBeVisible();
    await page.getByRole('button', { name: 'Freeze message view' }).click();
    await expect(page.getByRole('button', { name: 'Resume live message view' })).toBeVisible();
    await page.getByRole('button', { name: 'Resume live message view' }).click();
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
    await produce.getByRole('tab', { name: 'Transaction' }).click();
    const batchEditorInput = produce.getByRole('textbox', { name: 'Kafka typed record batch' });
    const batchEditor = batchEditorInput.locator(
      'xpath=ancestor::div[contains(@class, "monaco-editor")][1]'
    );
    await fillMonacoEditor(
      page,
      batchEditor,
      JSON.stringify([
        { topic, value: { encoding: 'utf8', data: transactionalValue }, partition: 0 },
      ])
    );
    await produce.getByRole('button', { name: 'Begin transaction' }).click();
    await produce.getByRole('button', { name: 'Send batch in transaction' }).click();
    await produce.getByRole('button', { name: 'Commit', exact: true }).click();
    await page.getByRole('tab', { name: /Messages/ }).click();
    await expect(page.getByText(transactionalValue)).toBeVisible({ timeout: 20_000 });

    // Tombstones are a true Kafka null, not an empty string.
    await page.getByRole('tab', { name: 'Produce' }).click();
    await produce.getByRole('tab', { name: 'Single record' }).click();
    await produce.getByRole('switch', { name: 'Tombstone (Kafka null value)' }).click();
    await expect(
      produce.getByRole('switch', { name: 'Tombstone (Kafka null value)' })
    ).toBeChecked();
    await produce.getByRole('button', { name: 'Publish' }).click();
    await page.getByRole('tab', { name: /Messages/ }).click();
    await expect(page.getByText('<tombstone>').first()).toBeVisible({ timeout: 20_000 });
    await page.getByText('<tombstone>').last().click();
    await expect(page.getByText(/Kafka null value/)).toBeVisible();

    await page
      .getByRole('button', { name: /Disconnect/ })
      .first()
      .click()
      .catch(() => {});
    expect(consoleErrors).toEqual([]);
  });

  test('browse mode reads the last N per partition without creating a consumer group', async ({
    app: page,
    brokers,
  }) => {
    const stamp = await page.evaluate(() => String(Date.now()));
    const topic = `restura-e2e-browse-${stamp}`;
    const value = (partition: number, index: number) => `browse-${stamp}-p${partition}-m${index}`;

    // Seed 3 records on each of 2 partitions straight through the native client.
    const admin = new Admin({ clientId: 'restura-e2e-browse', bootstrapBrokers: [brokers.kafka] });
    const producer = new Producer({
      clientId: 'restura-e2e-browse',
      bootstrapBrokers: [brokers.kafka],
      serializers: { value: (v?: string) => (v == null ? undefined : Buffer.from(v)) },
    });
    try {
      await admin.createTopics({ topics: [topic], partitions: 2, replicas: 1 });
      await producer.send({
        messages: [0, 1].flatMap((partition) =>
          [0, 1, 2].map((index) => ({ topic, partition, value: value(partition, index) }))
        ),
      });
      const groupsBefore = new Set((await admin.listGroups()).keys());

      await page.getByRole('button', { name: 'new request', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Kafka client' }).click();
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(page.getByRole('button', { name: /Disconnect/ })).toBeVisible({
        timeout: 20_000,
      });

      // Browse is the default: read-only badge, no group id, last-N start.
      await page.getByRole('tab', { name: 'Consume' }).click();
      const consume = page.getByRole('tabpanel', { name: 'Consume' });
      await expect(consume.getByRole('radio', { name: 'Browse' })).toBeChecked();
      await expect(consume.getByText('Read-only — no group')).toBeVisible();
      await expect(consume.getByLabel('Consumer group ID')).toHaveCount(0);
      await expect(consume.getByLabel('Consume start position')).toHaveValue('last-n');
      await consume.getByLabel('Records per partition').fill('2');
      await consume.getByPlaceholder('topic-name').fill(topic);
      await consume.getByRole('button', { name: 'Add', exact: true }).click();
      await consume.getByRole('button', { name: 'Subscribe', exact: true }).click();
      await expect(consume.getByText('Subscription: Subscribed')).toBeVisible({ timeout: 20_000 });

      // Last 2 per partition: m1 and m2 of each, never m0.
      await page.getByRole('tab', { name: /Messages/ }).click();
      for (const partition of [0, 1]) {
        for (const index of [1, 2]) {
          await expect(page.getByText(value(partition, index))).toBeVisible({ timeout: 20_000 });
        }
        await expect(page.getByText(value(partition, 0))).toHaveCount(0);
      }
      await expect(page.getByText(/read-only, no consumer group/)).toBeVisible();

      // Nothing joined, created or committed: no new Restura group (the generated
      // `restura-<id8>` default) and never the browse placeholder. Groups other
      // clients create on the shared broker meanwhile don't affect the check.
      const newGroups = Array.from((await admin.listGroups()).keys()).filter(
        (id) => !groupsBefore.has(id)
      );
      expect(newGroups.filter((id) => id.startsWith('restura-'))).toEqual([]);
      expect(newGroups.filter((id) => id.includes('restura_browse'))).toEqual([]);

      await page.getByRole('tab', { name: 'Consume' }).click();
      await consume.getByRole('button', { name: 'Unsubscribe' }).click();
      await expect(consume.getByText('Subscription: Idle')).toBeVisible();
      await page
        .getByRole('button', { name: /Disconnect/ })
        .first()
        .click();
      await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
    } finally {
      await admin.deleteTopics({ topics: [topic] }).catch(() => {});
      await producer.close().catch(() => {});
      await admin.close().catch(() => {});
    }
  });
});
